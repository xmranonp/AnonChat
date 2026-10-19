import subprocess, os, socket, time, atexit
def start(peers_json):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    p = subprocess.Popen(['node', os.path.join(os.path.dirname(__file__), 'fsocks.mjs'), peers_json, str(port)], stdout=subprocess.DEVNULL)
    atexit.register(p.terminate); time.sleep(0.3)
    os.environ['SOCKS'] = f'socks5h://127.0.0.1:{port}'
    return port
