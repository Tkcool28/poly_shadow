module.exports = {
  apps: [
    {
      name: 'leaderboard-scanner',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/leaderboard-scanner.ts',
      cron_restart: '0 */12 * * *', // Every 12 hours
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'history-backfiller',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/history-backfiller.ts',
      node_args: '--max-old-space-size=8192',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'score-calculator',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/score-calculator.ts',
      cron_restart: '0 */6 * * *', // Every 6 hours
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'trade-monitor',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/trade-monitor.ts',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'copy-trader',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/copy-trader.ts',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'arb-worker',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/arb-worker.ts',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'scalp-worker',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/scalp-worker.ts',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'scalp-observer',
      script: './node_modules/.bin/tsx',
      args: 'src/jobs/scalp-observer.ts',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
