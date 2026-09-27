// The fixed Python programs a container runs. They are never built from workspace content, and run with
// `python3 -I -S` (isolated: no user site, no PYTHON* variables, no site-packages). Ported from the CanvasTTY chain
// (ContainerBootstrap), cut down to what this plugin launches.
//
// BOOTSTRAP is the container's own entrypoint. From inside, it checks what the host asked for: no-new-privileges,
// every capability set empty, a private cgroup with the CPU/memory/PID limits, a read-only root, a noexec /tmp, the
// workspace at /workspace (writable, not shared back), no other host mount, and the one-time marker file the host
// wrote into the workspace (so /workspace is the folder the host prepared). Mode "hold" then waits for the card's
// shells (`exec`); mode "check" runs the saved check command once. Any failure exits 78 before anything else runs.
//
// EXEC starts each card process inside a held container (`docker exec` / `podman exec`): it re-checks privileges
// and the folder, picks the shell or the named program from the image's PATH, and passes only named variables.

export const BOOTSTRAP = String.raw`
import os, sys, json, stat, signal, tempfile
ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}

def fail(reason):
    sys.stderr.write('CanvasTTY container check failed: ' + reason + '.\n'); sys.stderr.flush(); os._exit(78)

def privileges():
    with open('/proc/self/status') as f: status = dict(line.split(':', 1) for line in f if ':' in line)
    if status.get('NoNewPrivs', '').strip() != '1': fail('no-new-privileges is off')
    if any(int(status.get(key, '-1').strip(), 16) != 0 for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']): fail('capabilities are not all dropped')

def limits(requested):
    with open('/proc/self/cgroup') as f:
        if f.read().strip() != '0::/': fail('the cgroup is not private')
    with open('/sys/fs/cgroup/cpu.max') as f: cpu = f.read().split()
    if len(cpu) != 2 or cpu[0] == 'max' or int(cpu[0]) <= 0 or int(cpu[1]) <= 0 or int(cpu[0]) / int(cpu[1]) > requested['cpus'] + 0.000001: fail('CPU limit')
    for name, maximum in [('memory.max', requested['memoryMb'] * 1048576), ('pids.max', requested['pids'])]:
        with open('/sys/fs/cgroup/' + name) as f: value = f.read().strip()
        if value == 'max' or int(value) <= 0 or int(value) > maximum: fail(name + ' limit')

def mounts():
    seen = set()
    with open('/proc/self/mountinfo') as f:
        for line in f:
            fields = line.split(); mount = fields[4].replace('\\040', ' '); options = fields[5].split(',')
            optional = fields[6:fields.index('-')]
            if mount == '/' and 'ro' not in options: fail('the root filesystem is writable')
            if mount == '/tmp' and any(flag not in options for flag in ['rw', 'nosuid', 'nodev', 'noexec']): fail('/tmp is not rw,nosuid,nodev,noexec')
            if mount == '/workspace' and ('rw' not in options or any(item.startswith('shared:') for item in optional)): fail('/workspace is read-only or shared')
            if mount == '/run/.containerenv' and 'ro' not in options: fail('container metadata is writable')
            if mount in ['/', '/tmp', '/workspace']: seen.add(mount); continue
            if mount in ['/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/run/.containerenv'] or mount.split('/')[1] in ['proc', 'sys', 'dev']: continue
            fail('unexpected mount ' + mount[:80])
    if len(seen) != 3: fail('a required mount is missing')

def workspace(marker):
    if os.path.realpath('/workspace') != '/workspace' or not os.path.isdir('/workspace'): fail('no /workspace folder')
    name = marker['name']
    if not name.startswith('.canvastty-container-') or '/' in name or len(name) != 57: fail('invalid marker')
    fd = os.open('/workspace/' + name, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or os.read(fd, 129).decode('ascii') != marker['token']: fail('/workspace is not the prepared folder')
    finally: os.close(fd)
    os.unlink('/workspace/' + name)
    fd, probe = tempfile.mkstemp(prefix='.canvastty-write-', dir='/workspace'); os.close(fd); os.unlink(probe)

def run():
    raw = os.environ.get('CANVASTTY_CONTAINER_RECIPE', '')
    if len(raw) > 16384: fail('recipe too large')
    recipe = json.loads(raw)
    privileges(); limits(recipe['limits']); mounts(); workspace(recipe['marker'])
    if recipe['mode'] == 'check':
        command = recipe['command']
        if not isinstance(command, str) or not command or len(command) > 4096: fail('invalid check command')
        os.chdir('/workspace'); sys.stdout.flush()
        os.execve('/bin/sh', ['/bin/sh', '-c', command], ENV)
    if recipe['mode'] != 'hold': fail('unknown mode')
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0)); signal.signal(signal.SIGINT, lambda *_: os._exit(0))
    while True: signal.pause()

try: run()
except SystemExit: raise
except Exception: fail('the recipe or the container could not be verified')
`;

export const EXEC = String.raw`
import os, sys, json
def fail(reason):
    sys.stderr.write('CanvasTTY container check failed: ' + reason + '.\n'); sys.stderr.flush(); os._exit(78)
try:
    r = json.loads(os.environ.get('CANVASTTY_CONTAINER_RECIPE', ''))
    s = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
    if s['NoNewPrivs'].strip() != '1' or any(int(s[key].strip(), 16) for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']): fail('privileges')
    cwd = r['cwd']
    if (cwd != '/workspace' and not cwd.startswith('/workspace/')) or os.path.realpath(cwd) != cwd or not os.path.isdir(cwd): fail('no folder ' + cwd[:80])
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TERM': os.environ.get('TERM', 'xterm-256color'), 'LANG': 'C.UTF-8'}
    for name in r.get('pass', []):
        if name in os.environ: env[name] = os.environ[name]
    name = r['command']
    if name == 'shell':
        args = ['-l']; program = next((p for p in ['/bin/bash', '/bin/sh'] if os.access(p, os.X_OK)), '')
    else:
        args = r['args']; program = '' if '/' in name else next((d + '/' + name for d in env['PATH'].split(':') if os.access(d + '/' + name, os.X_OK)), '')
    if not program: fail(name[:40] + ' is not installed in the image')
    os.chdir(cwd); os.execve(program, [program] + args, env)
except SystemExit: raise
except Exception: fail('the recipe could not be verified')
`;
