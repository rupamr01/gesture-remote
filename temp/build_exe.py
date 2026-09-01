import subprocess
import sys
import os

def install_and_build():
    print("[1/3] Checking environment & installing PyInstaller...")
    
    # Check if running inside virtualenv
    in_venv = sys.prefix != sys.base_prefix
    pip_cmd = [sys.executable, "-m", "pip", "install", "pyinstaller", "websockets", "pyautogui"]
    
    if not in_venv:
        # Pass flag for modern Linux environments outside venv
        pip_cmd.append("--break-system-packages")
        
    try:
        subprocess.check_call(pip_cmd)
    except subprocess.CalledProcessError as e:
        print(f"Pip install failed: {e}")
        return

    print("\n[2/3] Building Standalone Executable...")
    pyinstaller_cmd = [
        "pyinstaller",
        "--onefile",
        "--name=RemoteTrackpadServer",
        "--clean",
        "cursor_server.py"
    ]
    subprocess.check_call(pyinstaller_cmd)
    
    print("\n[3/3] Build Complete!")
    print(f"Executable File Location: {os.path.abspath('dist/RemoteTrackpadServer')}")

if __name__ == "__main__":
    install_and_build()
