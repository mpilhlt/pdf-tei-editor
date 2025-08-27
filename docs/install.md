# Installing pdf-tei-editor on a vanilla Ubuntu server

This is a recipe to install the application on a Ubuntu server, with a waitress WSGI server and a nginx https reverse proxy for https. Other contexts / platforms might need adaptations. 

## install uv
```shell
sudo apt update
apt-get install pipx
pipx install uv
```

## get the source
```shell
git clone https://github.com/mpilhlt/pdf-tei-editor.git
cd pdf-tei-editor/
uv sync
```

## install certbot for a SSL certificate
```shell
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d pdf-tei-editor.example.com
```

## install and configure nginx
```shell
sudo apt install nginx
sudo systemctl status nginx
sudo systemctl start nginx
sudo systemctl enable nginx
sudo nano /etc/nginx/sites-available/default
```

in the `default` config file, replace https server configuration with the following content (with `example.com` replaced by the actual domain name):

```conf
# https://pdf-tei-editor.example.com
server {
    server_name pdf-tei-editor.example.com; # managed by Certbot

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # Use https, not $scheme
        proxy_set_header X-Forwarded-Host $host;
        proxy_redirect off;
    }

    # Special handling for Server-Sent Events
    location /sse/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # Important for HTTPS
        proxy_set_header X-Forwarded-Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300;
        proxy_connect_timeout 75;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    # further SSL directives...
}
```

## check ngix configurea and start server
```shell
sudo nginx -t
sudo systemctl reload nginx
```

## Install node and app javascript dependencies

```shell
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install lts/jod
npm install
``` 

# Create a systemd service file:

```shell
sudo nano /etc/systemd/system/pdf-tei-editor.service
```
  
Add this content (make sure to replace `/path/to` with the actual path!):

```conf
[Unit]
Description=PDF TEI Editor
After=network.target

[Service]
Type=simple
User=cloud
WorkingDirectory=/path/to/pdf-tei-editor
Environment=PATH=/path/to/pdf-tei-editor/.venv/bin
ExecStart=/path/to/pdf-tei-editor/.venv/bin/python /path/to/pdf-tei-editor/bin/start-prod
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```shell
# Reload systemd
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable pdf-tei-editor
sudo systemctl start pdf-tei-editor

# Check status
sudo systemctl status pdf-tei-editor

# View logs
sudo journalctl -u pdf-tei-editor -f
```

After updating the codebase, you need to run 

```shell
sudo systemctl restart pdf-tei-editor
```