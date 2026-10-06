#!/bin/zsh
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
launch_agents="$HOME/Library/LaunchAgents"
logs_dir="$HOME/Library/Logs/apollo"
hermes_env="$HOME/.hermes/.env"
node_bin="$(command -v node)"
user_id="$(id -u)"

if [[ ! -f "$hermes_env" ]]; then
  print -u2 "Missing $hermes_env. Configure Hermes there first."
  exit 1
fi

mkdir -p "$launch_agents" "$logs_dir"

write_agent() {
  local label="$1"
  local command="$2"
  local plist="$launch_agents/$label.plist"

  /usr/bin/python3 - "$plist" "$label" "$command" "$repo_dir" "$hermes_env" "$logs_dir" <<'PY'
import plistlib
import sys

path, label, command, repo, env_file, logs = sys.argv[1:]
plistlib.dump({
    "Label": label,
    "ProgramArguments": ["/bin/zsh", "-lc", command],
    "WorkingDirectory": repo,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Interactive",
    "StandardOutPath": f"{logs}/{label}.out.log",
    "StandardErrorPath": f"{logs}/{label}.err.log",
    "EnvironmentVariables": {
        "APOLLO_HERMES_ENV": env_file,
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    },
}, open(path, "wb"))
PY
  chmod 600 "$plist"
  /bin/launchctl bootout "gui/$user_id/$label" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$user_id" "$plist"
  /bin/launchctl enable "gui/$user_id/$label"
}

write_agent \
  com.matthewchisolm.apollo-connector \
  "set -a; source \"$hermes_env\"; set +a; export HERMES_API_KEY=\"\${HERMES_API_KEY:-\${API_SERVER_KEY:-}}\"; exec \"$node_bin\" \"$repo_dir/connector/cli.mjs\" serve"

print "Installed and started the Apollo connector LaunchAgent."
print "Logs: $logs_dir"
