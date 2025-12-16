# Development Server

This document provides technical information about the FastAPI development server, including platform-specific considerations and troubleshooting.

## Starting the Development Server

### Basic Usage

```bash
npm run start:dev
```

This is a wrapper around:

```bash
uv run python bin/start-dev
```

### Command-Line Options

- `--restart`: Kill any existing server on the port and start a new one
- Host and port can be specified via arguments or environment variables:
  - `bin/start-dev localhost 8000`
  - `HOST=localhost PORT=8000 bin/start-dev`

### Environment Variables

- `HOST`: Server host (default: `localhost`)
- `PORT`: Server port (default: `8000`)
- `DISABLE_RELOAD`: Disable auto-reload on Unix/Mac (values: `1`, `true`, `yes`)
- `ENABLE_RELOAD`: Enable auto-reload on Windows (values: `1`, `true`, `yes`) - see Windows section below
- `FASTAPI_ALLOW_ANONYMOUS_ACCESS`: Bypass authentication for development/testing (values: `true`)

## Auto-Reload Behavior

### Unix/Linux/macOS

Auto-reload is **enabled by default** on Unix-based systems. The server uses uvicorn's `--reload` flag with watchfiles to detect file changes and automatically restart.

- File changes are detected via native file system events
- Server restarts automatically when Python files change
- Output is logged to `log/fastapi-server.log` and displayed in the terminal

To disable auto-reload on Unix:

```bash
DISABLE_RELOAD=true npm run start:dev
```

### Windows

Auto-reload is **disabled by default** on Windows due to a known issue with uvicorn's watchfiles library.

#### The Windows Auto-Reload Problem

Uvicorn's file watching system has a bug on Windows where:
1. File changes are detected correctly
2. The server shuts down as expected
3. **The server never restarts** - it remains shut down

This is a known upstream issue:
- [Uvicorn hangs on hot reload on Windows 10 after code changes](https://github.com/fastapi/fastapi/discussions/13817)
- [Uvicorn not reloading on file update](https://github.com/Kludex/uvicorn/discussions/1973)
- [v0.22.0 on Windows 10 took minutes to reload](https://github.com/Kludex/uvicorn/discussions/1977)

#### Workaround for Windows

**Manual Restart After Changes**

On Windows, after making code changes, restart the server manually:

```bash
npm run start:dev -- --restart
```

The `--restart` flag will:
1. Find the process using port 8000 (via `netstat -ano`)
2. Kill it (via `taskkill /F /PID`)
3. Start a new server instance

**Experimental: Enable Auto-Reload on Windows**

You can try enabling auto-reload on Windows (not recommended):

```bash
ENABLE_RELOAD=true npm run start:dev
```

However, you'll likely encounter the shutdown-without-restart issue described above.

## Platform-Specific Process Management

The development server includes platform-specific implementations for managing server processes:

### Finding Processes on Ports

**Windows** ([fastapi_app/lib/server_startup.py:53-65](../fastapi_app/lib/server_startup.py#L53-L65)):
```bash
netstat -ano
```
Parses output to find PIDs listening on specific ports.

**Unix/Linux/macOS** ([fastapi_app/lib/server_startup.py:67-75](../fastapi_app/lib/server_startup.py#L67-L75)):
```bash
lsof -ti :8000
```
Directly returns the PID using the port.

### Killing Processes

**Windows** ([fastapi_app/lib/server_startup.py:95-97](../fastapi_app/lib/server_startup.py#L95-L97)):
```bash
taskkill /F /PID <pid>
```

**Unix/Linux/macOS** ([fastapi_app/lib/server_startup.py:99-100](../fastapi_app/lib/server_startup.py#L99-L100)):
```bash
kill <pid>
```

## Server Startup Process

The development server startup process ([bin/start-dev](../bin/start-dev)):

1. **Load environment variables** from `.env` if present
2. **Check for `--restart` flag** and remove from arguments
3. **Determine host and port** from environment or CLI args
4. **Check if port is in use**:
   - If already running and no `--restart`: Show "already running" message and exit
   - If already running with `--restart`: Kill the existing process
5. **Set up logging** directory and file
6. **Determine auto-reload setting** based on platform:
   - Windows: Disabled by default
   - Unix/Mac: Enabled by default
7. **Build uvicorn command** with appropriate flags
8. **Start uvicorn** with output streaming to both console and log file

## Uvicorn Configuration

The development server uses these uvicorn settings:

```python
cmd = [
    'uv', 'run', 'uvicorn',
    'run_fastapi:app',
    '--host', host,
    '--port', str(port),
    '--log-level', 'info',
    '--timeout-graceful-shutdown', '1',  # Force reload after 1 second if connections don't close
    '--reload-delay', '0.25'  # Debounce rapid file changes
]

# Add --reload flag if enabled
if not disable_reload:
    cmd.insert(3, '--reload')
```

## Logging

Server output is logged to `log/fastapi-server.log` on all platforms. The script uses `subprocess.Popen` to capture stdout/stderr and stream it to both:
- The console (for real-time monitoring)
- The log file (for historical reference)

## Troubleshooting

### Port Already in Use

If you see "port already in use" errors:

```bash
# Check what's using the port
netstat -ano | findstr :8000    # Windows
lsof -ti :8000                   # Unix/Mac

# Restart the server (kills existing and starts new)
npm run start:dev -- --restart
```

### Server Not Starting on Windows

1. Check if Python/uvicorn processes are stuck:
   ```bash
   tasklist | findstr python
   ```

2. Kill stuck processes:
   ```bash
   taskkill /F /IM python.exe
   ```

3. Start fresh:
   ```bash
   npm run start:dev
   ```

### Auto-Reload Not Working

**On Windows**: This is expected behavior. Use `npm run start:dev -- --restart` after changes.

**On Unix/Mac**:
- Check that watchfiles is installed: `uv pip list | grep watchfiles`
- Check the log file for errors: `cat log/fastapi-server.log`
- Try disabling and re-enabling: `DISABLE_RELOAD=true npm run start:dev`

## Development Workflow

### Recommended Workflow on Windows

1. Start the server:
   ```bash
   npm run start:dev
   ```

2. Make code changes

3. Restart the server:
   ```bash
   npm run start:dev -- --restart
   ```

4. Repeat steps 2-3

### Recommended Workflow on Unix/Mac

1. Start the server (auto-reload enabled):
   ```bash
   npm run start:dev
   ```

2. Make code changes - server restarts automatically

3. Watch the console for reload confirmations

## Related Documentation

- [Development Commands](../code-assistant/development-commands.md) - Complete command reference
- [Testing Guide](../code-assistant/testing-guide.md) - Running tests during development
- [Deployment](deployment.md) - Production server setup
