# Windows Setup

Windows has several options for running Nova as an always-on service.

## Option 1: Task Scheduler (Built-in)

The simplest approach using Windows' built-in scheduler.

### Steps:

1. **Open Task Scheduler**
   - Press `Win + R`, type `taskschd.msc`, press Enter

2. **Create New Task**
   - Click "Create Task" (not "Create Basic Task" for more options)

3. **General Tab**
   - Name: `Nova`
   - Check "Run whether user is logged on or not"
   - Check "Run with highest privileges"

4. **Triggers Tab**
   - New > At startup
   - Or: New > At log on (if you prefer)

5. **Actions Tab**
   - New > Start a program
   - Program: `C:\Users\YOUR_USERNAME\.bun\bin\bun.exe`
   - Arguments: `run src/relay.ts`
   - Start in: `C:\path\to\nova`

6. **Settings Tab**
   - Check "If the task fails, restart every: 1 minute"
   - Check "Attempt to restart up to: 999 times"
   - Uncheck "Stop the task if it runs longer than"

7. **Click OK** and enter your password when prompted

### Commands:

```powershell
# Check if running
schtasks /query /tn "Nova"

# Start manually
schtasks /run /tn "Nova"

# Stop
schtasks /end /tn "Nova"
```

---

## Option 2: PM2 (Cross-Platform, Recommended)

PM2 is a process manager that works on all platforms. Best option if you want consistent behavior across Mac/Linux/Windows.

### Install:

```powershell
npm install -g pm2
npm install -g pm2-windows-startup  # For auto-start on Windows
```

### Setup:

```powershell
# Navigate to Nova directory
cd C:\path\to\nova

# Start Nova
pm2 start src/relay.ts --interpreter bun --name nova

# Save process list
pm2 save

# Setup Windows startup
pm2-startup install

# Other commands:
pm2 logs nova      # View logs
pm2 restart nova   # Restart
pm2 stop nova      # Stop
pm2 delete nova    # Remove
pm2 list                   # List all processes
```

---

## Option 3: NSSM (Windows Service)

NSSM (Non-Sucking Service Manager) turns any program into a proper Windows service.

### Install:

1. Download from https://nssm.cc/download
2. Extract to `C:\nssm`
3. Add to PATH or use full path

### Setup:

```powershell
# Install as service (opens GUI)
nssm install nova

# Or via command line:
nssm install nova "C:\Users\YOUR_USERNAME\.bun\bin\bun.exe" "run src/relay.ts"
nssm set nova AppDirectory "C:\path\to\nova"
nssm set nova DisplayName "Nova"
nssm set nova Description "Nova — Personal AI Assistant"
nssm set nova Start SERVICE_AUTO_START

# Set environment variables
nssm set nova AppEnvironmentExtra HOME=C:\Users\YOUR_USERNAME

# Start the service
nssm start nova
```

### Commands:

```powershell
nssm status nova   # Check status
nssm stop nova     # Stop
nssm start nova    # Start
nssm restart nova  # Restart
nssm remove nova   # Uninstall (confirm prompt)
```

---

## Troubleshooting

### Common Issues:

1. **"bun not found"**
   - Use full path: `C:\Users\YOUR_USERNAME\.bun\bin\bun.exe`
   - Or add Bun to system PATH

2. **"claude not found"**
   - Ensure Claude Code is installed: `npm install -g @anthropic-ai/claude-code`
   - Use full path in CLAUDE_PATH env variable

3. **Environment variables not loading**
   - For Task Scheduler: Set them in the task's "Actions" settings
   - For PM2: Use `pm2 start --env production`
   - For NSSM: Use `nssm set nova AppEnvironmentExtra VAR=value`

4. **Service won't start**
   - Check logs in Event Viewer > Windows Logs > Application
   - Run manually first to check for errors: `bun run src/relay.ts`

### Logs Location:

- Task Scheduler: Configure in task settings
- PM2: `%USERPROFILE%\.pm2\logs\`
- NSSM: Configure with `nssm set nova AppStdout C:\path\to\log.txt`
