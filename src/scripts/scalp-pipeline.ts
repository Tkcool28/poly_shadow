import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = createJobLogger('scalp-pipeline');

const PIPELINE_DURATION_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const INITIAL_OBSERVATION_MS = 2 * 60 * 60 * 1000; // 2 hours before starting paper trader
const MIN_SIGNALS_TO_START = 5;
const MAX_CHILD_RESTARTS = 5;
const CHILD_RESTART_DELAY_MS = 30_000;

interface ChildState {
  process: ChildProcess | null;
  restarts: number;
  name: string;
}

// Resolve tsx binary path
function getTsxPath(): string {
  // Try common locations
  const paths = [
    './node_modules/.bin/tsx',
    'npx',
  ];
  return paths[0]; // Use local tsx
}

class ScalpPipeline {
  private startTime = Date.now();
  private observer: ChildState = { process: null, restarts: 0, name: 'observer' };
  private paperTrader: ChildState = { process: null, restarts: 0, name: 'paper-trader' };
  private shuttingDown = false;
  private currentParams: Record<string, string> = {};

  async run(): Promise<void> {
    log.info('=== SCALP PIPELINE STARTING ===');
    log.info(`Duration: 24 hours | Observation: 2h | Analysis interval: 2h`);

    // Setup shutdown handlers
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));

    // Phase 0: Compilation check
    log.info('Phase 0: TypeScript compilation check...');
    try {
      await this.exec(getTsxPath(), ['--version']); // verify tsx exists
    } catch {
      log.error('tsx not found. Run: npm install');
      process.exit(1);
    }

    // Phase 1: Database setup
    log.info('Phase 1: Database migration...');
    try {
      await this.exec('npx', ['prisma', 'migrate', 'deploy']);
      await this.exec('npx', ['prisma', 'generate']);
    } catch (err: any) {
      log.warn(`Migration warning: ${err.message} — continuing with existing schema`);
    }

    // Reset ScalpCapital to fresh $1000 for clean comparison
    log.info('Resetting paper capital to $1000...');
    await prisma.scalpCapital.updateMany({
      where: { isPaper: true },
      data: {
        currentCapital: 1000,
        deployedCapital: 0,
        totalPnl: 0,
        totalCycles: 0,
        totalWins: 0,
        dailyLossUsd: 0,
        dailyLossResetAt: new Date(),
      },
    });

    // Phase 2: Start observer
    log.info('Phase 2: Starting observer...');
    this.spawnChild(this.observer, 'src/jobs/scalp-observer.ts', {
      SCALP_ENABLED: 'true',
    });

    // Wait for initial observation period
    log.info(`Collecting data for ${INITIAL_OBSERVATION_MS / 3600_000}h before paper trading...`);

    // Main loop: periodic analysis + paper trader management
    let paperTraderStarted = false;
    let lastAnalysis = 0;
    let observationExtensions = 0;

    while (!this.shuttingDown && this.elapsed() < PIPELINE_DURATION_MS) {
      await this.sleep(60_000); // Check every 1 minute

      const elapsed = this.elapsed();

      // Check if it's time for analysis
      if (elapsed >= INITIAL_OBSERVATION_MS && elapsed - lastAnalysis >= ANALYSIS_INTERVAL_MS) {
        log.info(`\n=== ANALYSIS at T+${this.formatElapsed()} ===`);

        const analysis = await this.runAnalysis();
        lastAnalysis = elapsed;

        if (!paperTraderStarted) {
          // Check if we have enough signals
          const signalCount = analysis?.signals?.completed ?? 0;

          if (signalCount >= MIN_SIGNALS_TO_START) {
            log.info(`Sufficient signals (${signalCount}), starting paper trader...`);
            this.currentParams = this.extractParams(analysis);
            this.startPaperTrader();
            paperTraderStarted = true;
          } else if (observationExtensions < 3) {
            // Extend observation by 2 more hours
            observationExtensions++;
            log.warn(`Insufficient signals (${signalCount}/${MIN_SIGNALS_TO_START}), extending observation (+2h, extension ${observationExtensions}/3)`);
          } else {
            // Start with defaults after max extensions
            log.warn(`Max extensions reached with ${signalCount} signals. Starting with conservative defaults.`);
            this.currentParams = {};
            this.startPaperTrader();
            paperTraderStarted = true;
          }
        } else {
          // Paper trader is running — check if params should be adjusted
          const newParams = this.extractParams(analysis);
          if (this.shouldAdjustParams(newParams)) {
            log.info('Adjusting parameters — restarting paper trader...');
            this.currentParams = newParams;
            this.killChild(this.paperTrader);
            await this.sleep(5000);
            this.startPaperTrader();
          }
        }
      }

      // Also start paper trader after extended wait even without analysis
      if (!paperTraderStarted && elapsed >= INITIAL_OBSERVATION_MS + (observationExtensions + 1) * ANALYSIS_INTERVAL_MS) {
        // Force start analysis and check
        const analysis = await this.runAnalysis();
        lastAnalysis = elapsed;
        const signalCount = analysis?.signals?.completed ?? 0;

        if (signalCount >= MIN_SIGNALS_TO_START || observationExtensions >= 3) {
          this.currentParams = this.extractParams(analysis);
          this.startPaperTrader();
          paperTraderStarted = true;
        } else {
          observationExtensions++;
        }
      }
    }

    // Phase 4: Final report
    log.info('\n=== PHASE 4: FINAL REPORT ===');
    await this.generateFinalReport();
    await this.shutdown('pipeline-complete');
  }

  private startPaperTrader(): void {
    const env: Record<string, string> = {
      SCALP_ENABLED: 'true',
      SCALP_DYNAMIC_EDGE: 'true',
      SCALP_STOP_LOSS_ENABLED: 'true',
      SCALP_CONFIDENCE_SIZING: 'true',
      SCALP_ENTRY_DELAY_MS: '5000',
      ...this.currentParams, // Analysis-recommended params (can be overridden below)
      // Fixed overrides — these take precedence over analysis recommendations
      SCALP_CONVERGENCE_SELL_TIMEOUT_MS: '600000', // 10min — 3min was too short, positions need time to converge
      SCALP_MAX_DAILY_LOSS_USD: '200', // Paper mode: allow more trades for data collection
      SCALP_MIN_NET_IMBALANCE: '0.70', // Only trade strong imbalance (27.6% win vs 17.4% at 0.3-0.5)
    };

    log.info('Paper trader env overrides:', env);
    this.spawnChild(this.paperTrader, 'src/jobs/scalp-worker.ts', env);
  }

  private extractParams(analysis: any): Record<string, string> {
    if (!analysis?.recommended) return {};
    const r = analysis.recommended;
    return {
      SCALP_MIN_NET_IMBALANCE: String(r.SCALP_MIN_NET_IMBALANCE ?? 0.30),
      SCALP_STOP_LOSS_CENTS: String(r.SCALP_STOP_LOSS_CENTS ?? 15),
      SCALP_TRAILING_STOP_CENTS: String(r.SCALP_TRAILING_STOP_CENTS ?? 5),
      SCALP_CONVERGENCE_SELL_TIMEOUT_MS: String(r.SCALP_CONVERGENCE_SELL_TIMEOUT_MS ?? 180000),
      SCALP_MIN_EDGE_CENTS: String(r.SCALP_MIN_EDGE_CENTS ?? 3),
    };
  }

  private shouldAdjustParams(newParams: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(newParams)) {
      const current = this.currentParams[key];
      if (!current) continue;
      const diff = Math.abs(parseFloat(value) - parseFloat(current));
      if (key.includes('CENTS') && diff >= 3) return true;
      if (key.includes('IMBALANCE') && diff >= 0.1) return true;
    }
    return false;
  }

  private spawnChild(state: ChildState, script: string, envOverrides: Record<string, string> = {}): void {
    if (state.process) {
      this.killChild(state);
    }

    const env = { ...process.env, ...envOverrides };
    const child = spawn(getTsxPath(), [script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    // Pipe child output to our stdout with prefix
    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        console.log(`[${state.name}] ${line}`);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        console.error(`[${state.name}] ${line}`);
      }
    });

    child.on('exit', (code) => {
      if (this.shuttingDown) return;
      log.warn(`${state.name} exited with code ${code}`);
      state.process = null;

      if (state.restarts < MAX_CHILD_RESTARTS) {
        state.restarts++;
        log.info(`Restarting ${state.name} in ${CHILD_RESTART_DELAY_MS / 1000}s (restart ${state.restarts}/${MAX_CHILD_RESTARTS})`);
        setTimeout(() => {
          if (!this.shuttingDown) {
            this.spawnChild(state, script, envOverrides);
          }
        }, CHILD_RESTART_DELAY_MS);
      } else {
        log.error(`${state.name} exceeded max restarts (${MAX_CHILD_RESTARTS})`);
      }
    });

    state.process = child;
    log.info(`${state.name} spawned (pid: ${child.pid})`);
  }

  private killChild(state: ChildState): void {
    if (state.process) {
      state.process.removeAllListeners('exit');
      state.process.kill('SIGTERM');
      state.process = null;
    }
  }

  private async runAnalysis(): Promise<any> {
    try {
      const result = await this.execCapture(getTsxPath(), [
        'src/scripts/scalp-analyze.ts', '--since', '24h', '--format', 'json',
      ]);
      const analysis = JSON.parse(result);

      // Log key metrics
      log.info(`Analysis: ${analysis.signals?.total ?? 0} signals, ${analysis.signals?.completed ?? 0} with data`);
      if (analysis.paperTrader) {
        log.info(`Paper PnL: $${analysis.paperTrader.totalPnl?.toFixed(2)}, ${analysis.paperTrader.totalWins}W/${analysis.paperTrader.totalCycles}T`);
      }

      return analysis;
    } catch (err: any) {
      log.error(`Analysis failed: ${err.message}`);
      return null;
    }
  }

  private async generateFinalReport(): Promise<void> {
    try {
      // Run full analysis
      const result = await this.execCapture(getTsxPath(), [
        'src/scripts/scalp-analyze.ts', '--since', '24h', '--format', 'text',
      ]);

      const report = [
        `# Scalp Pipeline Report — ${new Date().toISOString().slice(0, 10)}`,
        '',
        `## Runtime: ${this.formatElapsed()}`,
        '',
        result,
        '',
        `## Current Parameters`,
        ...Object.entries(this.currentParams).map(([k, v]) => `- ${k}=${v}`),
      ].join('\n');

      // Write report to logs directory
      const fs = await import('fs');
      const dir = 'logs';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const reportPath = `${dir}/scalp-pipeline-report-${new Date().toISOString().slice(0, 10)}.md`;
      fs.writeFileSync(reportPath, report);
      log.info(`Final report written to ${reportPath}`);

      // Also print to stdout
      console.log('\n' + report);
    } catch (err: any) {
      log.error(`Report generation failed: ${err.message}`);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info(`Shutting down (${reason})...`);

    this.killChild(this.observer);
    this.killChild(this.paperTrader);

    // Give children time to clean up
    await this.sleep(3000);

    await prisma.$disconnect();
    process.exit(0);
  }

  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  private formatElapsed(): string {
    const ms = this.elapsed();
    const h = Math.floor(ms / 3600_000);
    const m = Math.floor((ms % 3600_000) / 60_000);
    return `${h}h${m}m`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      // Check shuttingDown periodically so we don't block for too long
      const check = setInterval(() => {
        if (this.shuttingDown) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 5000);
      check.unref();
    });
  }

  private exec(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', cwd: process.cwd() });
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
      child.on('error', reject);
    });
  }

  private execCapture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => stdout += d.toString());
      child.stderr?.on('data', (d: Buffer) => stderr += d.toString());
      child.on('exit', code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${stderr.slice(0, 500)}`));
      });
      child.on('error', reject);
    });
  }
}

const pipeline = new ScalpPipeline();
pipeline.run().catch(err => {
  console.error('Pipeline fatal error:', err);
  process.exit(1);
});
