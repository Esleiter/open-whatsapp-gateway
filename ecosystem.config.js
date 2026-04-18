module.exports = {
    apps: [{
        name: 'whatsapp-gateway',
        script: 'index.js',
        node_args: '--env-file=.env',
        restart_delay: 5000,
        max_restarts: 20,
        min_uptime: '30s',
        exp_backoff_restart_delay: 100,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: 'logs/error.log',
        out_file: 'logs/out.log',
        merge_logs: true,
    }]
};
