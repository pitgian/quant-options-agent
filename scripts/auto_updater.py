import time
import subprocess
import sys
import os
import datetime

import argparse
import shutil
import tempfile

scripts_dir = os.path.dirname(os.path.abspath(__file__))
python_executable = sys.executable

def run_script(script_name, args=[]):
    script_path = os.path.join(scripts_dir, script_name)
    cmd = [python_executable, script_path] + args
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Running: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Success: {script_name}")
        # Print summary or stdout if small
        lines = result.stdout.strip().split('\n')
        for line in lines[-3:]: # Print last 3 lines
            print(f"  > {line}")
    except subprocess.CalledProcessError as e:
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ERROR running {script_name}: {e.stderr}", file=sys.stderr)

def push_data_to_github():
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Syncing options data to GitHub remote 'data' branch...")
    try:
        repo_root = os.path.dirname(scripts_dir)
        git_url_proc = subprocess.run(["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True, cwd=repo_root)
        remote_url = git_url_proc.stdout.strip()
        if not remote_url:
            print("  > Error: Could not get remote.origin.url. Skipping push.")
            return

        local_opt = os.path.join(repo_root, "data", "options_data.json")
        local_kro = os.path.join(repo_root, "data", "kronos_forecast.json")
        if not os.path.exists(local_opt) or not os.path.exists(local_kro):
            print("  > Error: Local data files not found. Skipping push.")
            return

        with tempfile.TemporaryDirectory() as tmpdir:
            print(f"  > Cloning data branch into temporary path: {tmpdir}")
            subprocess.run(["git", "clone", "--depth", "1", "--branch", "data", remote_url, tmpdir], check=True, capture_output=True)
            
            # Copy new data files to temp clone
            shutil.copy(local_opt, os.path.join(tmpdir, "data", "options_data.json"))
            shutil.copy(local_kro, os.path.join(tmpdir, "data", "kronos_forecast.json"))
            
            # Configure Git inside temporary clone
            subprocess.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd=tmpdir, check=True)
            subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=tmpdir, check=True)

            subprocess.run(["git", "add", "data/options_data.json", "data/kronos_forecast.json"], cwd=tmpdir, check=True)
            
            diff_proc = subprocess.run(["git", "diff", "--staged", "--quiet"], cwd=tmpdir)
            if diff_proc.returncode == 0:
                print("  > No new changes detected. Skipping push.")
                return
                
            subprocess.run(["git", "commit", "-m", "chore: update options data [local auto-updater] [skip ci]"], cwd=tmpdir, check=True, capture_output=True)
            print("  > Pushing changes to origin 'data' branch...")
            subprocess.run(["git", "push", "origin", "data"], cwd=tmpdir, check=True, capture_output=True)
            print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Push to GitHub data branch completed successfully!")
    except Exception as e:
        print(f"  > Error during GitHub push sync: {e}", file=sys.stderr)

def main():
    parser = argparse.ArgumentParser(description="Local Options & Kronos Auto-Update Daemon")
    parser.add_argument(
        "--push",
        action="store_true",
        help="Automatically push newly generated data files to the GitHub 'data' branch"
    )
    args = parser.parse_args()

    print("🚀 Starting local auto-update daemon for Options & Kronos forecasts...")
    if args.push:
        print("📢 Git sync enabled: updates will be pushed to origin 'data' branch.")
    print("Press Ctrl+C to stop.")
    
    # Run once at startup
    run_script("fetch_options_data.py", ["--symbol", "ALL"])
    run_script("run_kronos.py")
    if args.push:
        push_data_to_github()
    
    interval_seconds = 10 * 60 # 10 minutes
    
    try:
        while True:
            print(f"⏳ Sleeping for {interval_seconds // 60} minutes...")
            time.sleep(interval_seconds)
            run_script("fetch_options_data.py", ["--symbol", "ALL"])
            run_script("run_kronos.py")
            if args.push:
                push_data_to_github()
    except KeyboardInterrupt:
        print("\n👋 Auto-update daemon stopped.")

if __name__ == "__main__":
    main()
