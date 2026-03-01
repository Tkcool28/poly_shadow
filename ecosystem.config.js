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
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
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
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
