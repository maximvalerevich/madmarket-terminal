#!/usr/bin/env bash
# MadMarket Deployment Script for Ubuntu/Debian

set -e

# Default variables
APP_DIR="/opt/bookmaker"
SERVICE_NAME="bookmaker"

install_node() {
    echo "Checking Node.js version..."
    if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
        echo "Installing Node.js 20+ via NVM..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install 20
        nvm use 20
        nvm alias default 20
    else
        echo "Node.js 20+ is already installed."
    fi
}

setup_app() {
    echo "Setting up application in $APP_DIR..."
    
    if [ ! -d "$APP_DIR" ]; then
        echo "Directory $APP_DIR does not exist. Please clone the repository first."
        echo "Example: git clone <repo_url> $APP_DIR"
        exit 1
    fi

    cd "$APP_DIR"
    
    echo "Installing dependencies..."
    npm install --production

    if [ ! -f "config.json" ]; then
        echo "Copying config.example.json to config.json..."
        cp config.example.json config.json
    fi
    
    setup_service
    echo "Setup complete."
}

setup_service() {
    echo "Setting up systemd service..."
    NODE_PATH=$(which node)
    
    cat <<EOF | sudo tee /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=MadMarket Terminal
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_PATH index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable ${SERVICE_NAME}
    echo "Service configured."
}

update_auth() {
    SESSION_TOKEN=$1
    INSTANCE_ID=$2
    
    if [ -z "$SESSION_TOKEN" ] || [ -z "$INSTANCE_ID" ]; then
        echo "Usage: deploy.sh auth <sessionToken> <instanceId>"
        exit 1
    fi

    cd "$APP_DIR"
    
    if [ ! -f "config.json" ]; then
        echo "config.json not found! Run setup first."
        exit 1
    fi

    echo "Updating credentials in config.json..."
    
    # We use a temporary node script to update JSON reliably
    node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    if (!cfg.adapters) cfg.adapters = {};
    if (!cfg.adapters.mollybet) cfg.adapters.mollybet = {};
    cfg.adapters.mollybet.sessionToken = '$SESSION_TOKEN';
    cfg.adapters.mollybet.instanceId = '$INSTANCE_ID';
    fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2));
    "
    
    echo "Credentials updated."
}

start_app() {
    echo "Starting service..."
    sudo systemctl start ${SERVICE_NAME}
    echo "Service started."
}

stop_app() {
    echo "Stopping service..."
    sudo systemctl stop ${SERVICE_NAME}
    echo "Service stopped."
}

show_logs() {
    sudo journalctl -u ${SERVICE_NAME} -f
}

case "$1" in
    setup)
        install_node
        setup_app
        ;;
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    auth)
        update_auth "$2" "$3"
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 {setup|start|stop|auth <token> <instanceId>|logs}"
        exit 1
esac
