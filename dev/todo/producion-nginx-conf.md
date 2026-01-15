# Production Nginx Configuration for FastAPI Application

This document outlines the recommended Nginx configuration for production deployment of the FastAPI application, focusing on protection, optimization, and scalability.

## Overview

For production deployments, it's recommended to use Nginx as a reverse proxy in front of the FastAPI application. This provides several benefits:

- Load balancing across multiple application instances
- Request rate limiting and DDoS protection
- Efficient handling of static assets
- SSL termination and HTTPS support
- Connection management and buffering
- Enhanced security through request filtering

## Basic Nginx Configuration Structure

```nginx
upstream fastapi_backend {
    server 127.0.0.1:8000;
    server 127.0.0.1:8001;
    server 127.0.0.1:8002;
}

server {
    listen 80;
    server_name your-domain.com;
    
    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
    
    # API endpoints with protection
    location /api/ {
        # Rate limiting
        limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
        limit_req zone=api burst=20 nodelay;
        
        # Connection limiting
        limit_conn_zone $binary_remote_addr zone=conn_limit_per_ip:10m;
        limit_conn conn_limit_per_ip 10;
        
        proxy_pass http://fastapi_backend;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_buffering on;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
        
        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        add_header X-XSS-Protection "1; mode=block";
    }
    
    # Static files (if served by Nginx)
    location /static/ {
        alias /path/to/static/files/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # Redirect HTTP to HTTPS (if applicable)
    location / {
        return 301 https://$server_name$request_uri;
    }
}
```

## Key Protection Mechanisms

### 1. Rate Limiting

```nginx
# Define rate limiting zones
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api_high:10m rate=50r/s;

# Apply to API endpoints
location /api/ {
    limit_req zone=api burst=20 nodelay;
    proxy_pass http://fastapi_backend;
}
```

### 2. Connection Limits

```nginx
# Limit concurrent connections per IP
limit_conn_zone $binary_remote_addr zone=conn_limit_per_ip:10m;
limit_conn conn_limit_per_ip 10;

# Limit connections to backend
limit_conn_zone $binary_remote_addr zone=backend_conn:10m;
limit_conn backend_conn 5;
```

### 3. Request Size Limits

```nginx
# Set maximum request body size
client_max_body_size 100M;
client_body_timeout 120s;

# Set timeouts for proxy connections
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
```

### 4. Security Headers

```nginx
add_header X-Content-Type-Options nosniff;
add_header X-Frame-Options DENY;
add_header X-XSS-Protection "1; mode=block";
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

## Optimization Settings

### Buffering Configuration

```nginx
# Optimize buffering for large requests/responses
proxy_buffering on;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
proxy_temp_file_write_size 128k;
```

### Gzip Compression

```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
gzip_min_length 1000;
gzip_comp_level 6;
```

## SSL/TLS Configuration (Recommended for Production)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /path/to/certificate.crt;
    ssl_certificate_key /path/to/private.key;
    
    # SSL security settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    location / {
        proxy_pass http://fastapi_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Health Checks and Monitoring

### Health Check Endpoint

```nginx
location /health {
    access_log off;
    return 200 "healthy\n";
    add_header Content-Type text/plain;
}
```

### Monitoring with Nginx Status Module

```nginx
# Enable in nginx.conf
http {
    # ... other config
    
    server {
        listen 127.0.0.1:8080;
        location /nginx_status {
            stub_status on;
            access_log off;
            allow 127.0.0.1;
            deny all;
        }
    }
}
```

## Deployment Considerations

### Multiple Application Instances

```nginx
upstream fastapi_backend {
    server 127.0.0.1:8000 weight=3;
    server 127.0.0.1:8001 weight=2;
    server 127.0.0.1:8002 backup;
}
```

### Load Balancing Strategies

- **Round Robin** (default): Distributes requests evenly
- **Weighted**: Assigns different weights to instances
- **Least Connections**: Sends requests to least busy server
- **IP Hash**: Ensures same client IP always goes to same server

## Best Practices

1. **Always Use HTTPS**: Never deploy without SSL/TLS encryption
2. **Monitor Logs**: Regularly review Nginx access/error logs
3. **Update Regularly**: Keep Nginx and SSL certificates up to date
4. **Test Configuration**: Always validate Nginx config before deployment
5. **Backup Configuration**: Maintain backups of critical Nginx configs
6. **Set Appropriate Timeouts**: Balance between performance and resource usage

## Testing the Configuration

Before deploying to production:

1. Test Nginx configuration: `sudo nginx -t`
2. Reload Nginx: `sudo systemctl reload nginx`
3. Monitor logs: `tail -f /var/log/nginx/access.log`
4. Verify health checks work properly
5. Test rate limiting behavior under load

## Troubleshooting Common Issues

### High Memory Usage

- Adjust proxy buffer sizes
- Implement proper connection limits
- Monitor backend connections

### Slow Response Times

- Check proxy timeouts
- Review buffering settings
- Monitor backend performance

### Rate Limiting Too Aggressive

- Increase rate limits
- Use different zones for different endpoints
- Implement burst handling appropriately

This configuration provides a robust foundation for production deployment while maintaining flexibility for future scaling needs.
END_ARG
