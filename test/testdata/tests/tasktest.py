from collections import defaultdict, Counter
from glob import glob
import humanize
import json
from os import getcwd, chdir, makedirs
from os.path import abspath, basename, dirname, exists, join, isdir, isfile
import re
import shlex
import subprocess
from sys import platform as PLATFORM, stdout, stderr
from time import time


def main():  # noqa: D103
    args = parse_args()

    init(args)

    makedirs(WORKDIR, exist_ok=True)
    chdir(WORKDIR)

    reset_workdir()
    configure_source(args)

    task('0200-scan')
    scn_out = batch_stats('scn-out', ['flags'], True)

    expected_flags = (
        (EntryFlags.PERMISSIONS if args.permissions else 0)
        | (EntryFlags.SIGNING if args.signing else 0)
        | (EntryFlags.INDEX if args.index else 0)
        | (EntryFlags.VECTORIZE if args.vectorize else 0)
        | (EntryFlags.OCR if args.ocr else 0)
        | (EntryFlags.CLASSIFY if args.classify else 0)
    )

    assert scn_out.exists, f'{scn_out.file_name}: not exists'
    assert scn_out.count > 0, f'{scn_out.file_name}: no entries'
    assert scn_out.objects['A'].count == scn_out.count, f'{scn_out.file_name}: unexpected entries'
    assert scn_out.field_count['flags'] == scn_out.count, f'{scn_out.file_name}: not enough flags'
    assert len(scn_out.field_values['flags']) == 1, f'{scn_out.file_name}: too many unique flags'
    assert single(scn_out.field_values['flags']) == expected_flags, f'{scn_out.file_name}: wrong flags'

    task('0250-permissions')

    prm_inp = batch_stats('perms-inp', ['permissionId'])

    assert prm_inp.exists, f'{prm_inp.file_name}: not exists'
    assert prm_inp.count > 0, f'{prm_inp.file_name}: no entries'
    assert prm_inp.objects['O'].count == prm_inp.count, f'{prm_inp.file_name}: unexpected entries'
    assert prm_inp.field_count['permissionId'] == 0, f'{prm_inp.file_name}: unexpected permissions'

    prm_out = batch_stats('perms-out', ['permissionId'])

    assert prm_out.exists, f'{prm_out.file_name} not exists'
    assert prm_out.count > 0, f'{prm_out.file_name}: no entries'
    assert prm_out.objects['O'].count == prm_inp.count, f'{prm_out.file_name}: unexpected entries'

    if args.permissions:
        assert prm_out.objects['O'].field_count['permissionId'] == prm_inp.count, f'{prm_out.file_name}: no permissions'
        assert prm_out.objects['U'].count > 0, f'{prm_out.file_name}: no user entries'
        assert prm_out.objects['G'].count > 0, f'{prm_out.file_name}: no group entries'
        assert prm_out.objects['P'].count > 0, f'{prm_out.file_name}: no permission set entries'
    else:
        assert prm_out.count == prm_inp.count, f'{prm_out.file_name}: unexpected entries'
        assert prm_out.field_count['permissionId'] == 0, f'{prm_out.file_name}: unexpected permissions'

    task('0300-instance')

    ins_inp = batch_stats('ins-inp', ['componentId'])

    assert ins_inp.exists, f'{ins_inp.file_name}: not exists'
    assert ins_inp.count > 0, f'{ins_inp.file_name}: no entries'
    assert ins_inp.objects['I'].count == ins_inp.count, f'{ins_inp.file_name}: unexpected entries'
    assert ins_inp.field_count['componentId'] == 0, f'{ins_inp.file_name}: unexpected hashes'
    assert ins_inp.objects['I'].field_count['wordBatchId'] == 0, f'{ins_inp.file_name}: unexpected word batches'
    assert ins_inp.objects['I'].field_count['vectorBatchId'] == 0, f'{ins_inp.file_name}: unexpected vector batches'

    ins_out = batch_stats('ins-out', ['componentId', 'wordBatchId', 'vectorBatchId'], True)

    assert ins_out.exists, f'{ins_out.file_name}: not exists'
    assert ins_out.objects['I'].count == ins_inp.count, f'{ins_out.file_name}: unexpected entries'

    if args.signing:
        assert ins_out.field_count['componentId'] == ins_inp.count, f'{ins_out.file_name}: no hashes'
        assert all(
            re.match(r'^[0-9a-fA-F]{128}$', componentId) for componentId in ins_out.field_values['componentId']
        ), f'{ins_out.file_name}: wrong hashes'
    else:
        assert ins_out.field_count['componentId'] == 0, f'{ins_out.file_name}: unexpected hashes'

    if args.index:
        assert ins_out.objects['I'].field_count['wordBatchId'] == ins_inp.count, f'{ins_out.file_name}: no word batches'
        assert ins_out.objects['W'].count > 0, f'{ins_out.file_name}: no word entries'
    else:
        assert ins_out.objects['I'].field_count['wordBatchId'] == 0, f'{ins_out.file_name}: unexpected word batches'

    if args.vectorize:
        assert ins_out.objects['I'].field_count['vectorBatchId'] == ins_inp.count, (
            f'{ins_out.file_name}: no vector batches'
        )
    else:
        assert ins_out.objects['I'].field_count['vectorBatchId'] == 0, f'{ins_out.file_name}: unexpected vector batches'

    task('0400-classify')

    cls_inp = batch_stats('cls-inp', ['classifications'])

    assert cls_inp.exists, f'{cls_inp.file_name}: not exists'
    assert cls_inp.count > 0, f'{cls_inp.file_name}: no entries'
    assert cls_inp.objects['C'].count == cls_inp.count, f'{cls_inp.file_name}: unexpected entries'
    assert cls_inp.field_count['classifications'] == 0, f'{cls_inp.file_name}: unexpected classifications'

    cls_out = batch_stats('cls-out', ['classifications'])

    assert cls_out.exists, f'{cls_out.file_name}: not exists'

    if args.classify:
        assert cls_out.count == cls_inp.count, f'{cls_out.file_name}: no entries'
        assert cls_out.objects['C'].count + cls_out.objects['E'].count == cls_out.count, (
            f'{cls_out.file_name}: unexpected entries'
        )
        assert cls_out.field_count['classifications'] > 0, f'{cls_out.file_name}: no classifications'
    else:
        assert cls_out.count == 0, f'{cls_out.file_name}: unexpected entries'

    pass


#
# IMPLEMENTATION DETAILS
#

_print = print


def print(*args):  # noqa: D103
    _print(*args)
    # flash output streams to sync python output
    # with subprocess outputs
    stdout.flush()
    stderr.flush()


_open = open


def open(path, *args, **kwargs):  # noqa: D103
    # let's open in utf-8 by default
    if 'encoding' not in kwargs:
        kwargs['encoding'] = 'utf-8'
    return _open(path, *args, **kwargs)


def single(items):  # noqa: D103
    (val,) = items
    return val


def parse_args():  # noqa: D103
    from argparse import ArgumentParser

    parser = ArgumentParser()
    parser.add_argument(
        '--engine',
        dest='engine',
        default='auto',
        metavar='<path>',
        help='path to engine binary, auto by default',
    )
    parser.add_argument(
        '--root',
        dest='root_dir',
        metavar='<path>',
        help='path to directory with testdata and user.json, ../.. by default',
    )
    parser.add_argument(
        '--work',
        dest='work_dir',
        metavar='<path>',
        help='path to work directory, <engine-dir>/.tasktest by default',
    )
    parser.add_argument(
        '--source',
        dest='service_type',
        default='filesys',
        metavar='<type>',
        help='source service type, filesys by default',
    )
    parser.add_argument(
        '--include',
        dest='include_path',
        metavar='<path>',
        help='include path pattern to scan, e.g. /home/user/documents/*',
    )
    parser.add_argument(
        '-p',
        '--permissions',
        action='store_true',
        dest='permissions',
        help='enable permissions',
    )
    parser.add_argument('-s', '--signing', action='store_true', dest='signing', help='enable signing')
    parser.add_argument('-i', '--index', action='store_true', dest='index', help='enable index')
    parser.add_argument('-a', '--ai', action='store_true', dest='vectorize', help='enable AI')
    parser.add_argument('-o', '--ocr', action='store_true', dest='ocr', help='enable OCR')
    parser.add_argument(
        '-c',
        '--classify',
        action='store_true',
        dest='classify',
        help='enable classifications',
    )

    args = parser.parse_args()

    if 'help' in args:
        parser.print_help()
        exit(1)

    if args.classify and not args.index and not args.vectorize:
        args.index = True
    if (args.index or args.vectorize) and not args.signing:
        args.signing = True

    return args


ROOT_DIR: str = None
USER_TEMPLATE_FILE: str = None
TESTDATA_TEMPLATE_DIR: str = None

ENGINE_NAME = 'engine.exe' if PLATFORM == 'win32' else 'engine'
ENGINE_DIR: str = None
ENGINE_FILE: str = None
WORKDIR: str = None
USER_FILE: str = None
TESTDATA_DIR: str = None


def init(args):  # noqa: D103
    global ROOT_DIR
    ROOT_DIR = abspath(args.root_dir) if args.root_dir else dirname(dirname(dirname(abspath(__file__))))

    global USER_TEMPLATE_FILE
    for user_config_name in ['user.json', 'user.template.json']:
        USER_TEMPLATE_FILE = join(ROOT_DIR, user_config_name)
        if exists(USER_TEMPLATE_FILE) and isfile(USER_TEMPLATE_FILE):
            break

    global TESTDATA_TEMPLATE_DIR
    TESTDATA_TEMPLATE_DIR = join(ROOT_DIR, 'testdata')

    global ENGINE_DIR, ENGINE_FILE
    if args.engine == 'auto':
        for engine_subdir in ['', join('build', 'apps', 'engine')]:
            ENGINE_DIR = join(ROOT_DIR, engine_subdir) if engine_subdir else ROOT_DIR
            ENGINE_FILE = join(ENGINE_DIR, ENGINE_NAME)
            if exists(ENGINE_FILE) and isfile(ENGINE_FILE):
                break
    else:
        ENGINE_FILE = abspath(args.engine)
        ENGINE_DIR = dirname(ENGINE_FILE)

    global WORKDIR, USER_FILE, TESTDATA_DIR
    WORKDIR = abspath(args.work_dir) if args.work_dir else join(ENGINE_DIR, '.tasktest')
    USER_FILE = join(WORKDIR, 'user.json')
    TESTDATA_DIR = join(WORKDIR, 'testdata')


class EntryFlags:
    NONE = 0x000
    INDEX = 0x001
    CLASSIFY = 0x002
    OCR = 0x004
    MAGICK = 0x008
    # IMGREC = 0x010
    # AUDTTS = 0x020
    SIGNING = 0x040
    OCR_DONE = 0x080
    PERMISSIONS = 0x100
    VECTORIZE = 0x200


def reset_workdir():
    """Reset testdata directory and user.json file in work directory."""
    for path in glob(join(WORKDIR, '*')):
        name = basename(path)
        if name not in ('user.json', 'testdata'):
            raise Exception(f'Invalid working directory: {WORKDIR}')

    rmdir(TESTDATA_DIR)

    for name in ['pipelines', 'source', 'tasks']:
        copy(join(TESTDATA_TEMPLATE_DIR, name), join(TESTDATA_DIR, name))

    copy(USER_TEMPLATE_FILE, USER_FILE)
    strip_json_file(USER_FILE)


def configure_source(args):
    """Configure user.json file, set specified service as scan service and update appropiate scan flags."""
    service_flags = ''.join(
        (
            '[sign]' if args.signing else '',
            '[perms]' if args.permissions else '',
            '[index]' if args.index else '',
            '[ai]' if args.vectorize else '',
            '[ocr]' if args.ocr else '',
            '[classify]' if args.classify else '',
        )
    )
    if not service_flags:
        service_flags = '[core]'
    print(f'Configure: {args.service_type} {service_flags}')

    config = None
    with open(USER_FILE, 'r') as f:
        config = json.load(f)

    service_key = None
    for service_key_, service_config in config['services'].items():
        if (
            service_config.get('type', '').casefold() == args.service_type.casefold()
            and service_config.get('mode', '').casefold() == 'source'
        ):
            service_key = service_key_
            break
    else:
        raise Exception(f'source service configuration not found: {args.service_type}')

    config_update = {
        'variables': {'sourceService': service_key},
        'services': {
            service_key: {
                'include': [
                    {
                        'signing': args.signing,
                        'permissions': args.permissions,
                        'index': args.index,
                        'ocr': args.ocr,
                        'vectorize': args.vectorize,
                        'classify': args.classify,
                    }
                ],
            }
        },
    }

    if args.include_path:
        config_update['services'][service_key]['include'][0]['path'] = args.include_path

    dict_update_deep(config, config_update)

    with open(USER_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def engine(*args):
    """Execute engine binary with specified command line arguments."""
    cmd(ENGINE_FILE, *args)


def task(task_name: str):
    """Execute specified test tasks."""
    tasks = sorted(
        (
            (path, name, int(m.group(1)))
            for path, name, m in (
                (path, basename(path), re.match(r'^(\d+)-.+\.json$', basename(path)))
                for path in glob(join(TESTDATA_DIR, 'tasks', task_name, '*.json'))
            )
            if m and name != '05-scanConsole.json'
        ),
        key=lambda x: x[2],
    )

    # engine(join(TESTDATA_DIR, 'tasks', task_name))

    for path, _, _ in tasks:
        engine(path)


def cmd_line(*args) -> str:
    """Escapes arguments for command line."""
    return subprocess.list2cmdline(args) if PLATFORM == 'win32' else ' '.join(shlex.quote(arg) for arg in args)


def cmd(*args):
    """Execute command line. Raises an exception if the command exit code is non-zero."""
    print(f'{getcwd()}>{cmd_line(*args)}')
    start_time = time()
    try:
        subprocess.run(args, check=True, shell=False)
    finally:
        elapsed_time = time() - start_time
        print(f'Completed in {humanize.naturaldelta(elapsed_time)}')
    print()


def rmdir(path: str):
    """Remove directory with readonly files."""
    if exists(path):
        import errno
        from os import chmod as _chmod, unlink as _unlink
        from shutil import rmtree as _rmtree
        import stat

        def onerror(_, _path, exc_info):
            if isinstance(exc_info[1], PermissionError) and exc_info[1].errno == errno.EACCES:
                _chmod(_path, stat.S_IWRITE)
                _unlink(_path)

        _rmtree(path, onerror=onerror)


def copy(src: str, dst: str):
    """Copy file or directory recursively."""
    from shutil import copyfile, copytree

    if not exists(src):
        raise Exception(f'path not found {src}')
    elif isfile(src):
        copyfile(src, dst)
    elif isdir(src):
        copytree(src, dst)
    else:
        raise Exception(f'path not supported: {src}')


def strip_json_file(json_file: str):
    """Remove the comments from JSON file."""
    json_text = None
    with open(json_file, 'r') as f:
        json_text = f.read()
    json_text = re.sub(r'\s+//.*$', '', json_text, flags=re.M)
    with open(json_file, 'w') as f:
        f.write(json_text)


def dict_update_deep(data: dict, updates: dict):
    """Update one dict with another recursively."""
    for prop in updates:
        update_val = updates[prop]
        if isinstance(update_val, dict):
            data_val = data[prop]
            dict_update_deep(data_val, update_val)
        elif isinstance(update_val, list):
            data_val = data[prop]
            for i in range(len(update_val)):
                dict_update_deep(data_val[i], update_val[i])
        else:
            data[prop] = update_val


class BatchObjectCount:
    def __init__(self):  # noqa: D107
        self.count = 0
        self.field_count = Counter()
        self.field_values = defaultdict(set)


class BatchStats(BatchObjectCount):
    def __init__(self):  # noqa: D107
        super().__init__()
        self.file_name: str = None
        self.exists = False
        self.objects = defaultdict(BatchObjectCount)


def batch_stats(batch_name: str, fields: list, values=False) -> BatchStats:
    """
    Aggregate content info of for the batch file.

    Args:
        batch_name: The name of the batch file.
        fields: The list of the field to collect.
        values: Collect the values of the specified fields.
    """
    stats = BatchStats()

    batch_num = 1

    while True:
        file_name = join(TESTDATA_DIR, 'control', f'{batch_name}.{batch_num:08d}.dat')

        if batch_num == 1:
            stats.file_name = file_name
            stats.exists = exists(file_name)

        if not exists(file_name):
            break

        with open(file_name, 'r', errors='ignore') as f:
            _ = f.readline()  # header
            for line in f:
                if line[0] == '+':
                    _ = line[1:]  # container_url
                elif line[0] == '#':
                    pass
                else:
                    op = line[0]
                    entry = json.loads(line[2:])
                    entry['operation'] = op

                    stats.count += 1
                    stats.objects[op].count += 1

                    for field in (f for f in fields if f in entry):
                        stats.field_count[field] += 1
                        stats.objects[op].field_count[field] += 1

                        if values:
                            value = entry[field]
                            stats.field_values[field].add(value)
                            stats.objects[op].field_values[field].add(value)

        batch_num += 1

    return stats


try:
    main()

    print('\033[92m[PASSED]\033[0m All tasks passed successfully')
    exit(0)

except (SystemExit, KeyboardInterrupt):
    pass

except BaseException:
    import traceback

    print('\033[91m[FAILED]\033[0m')
    traceback.print_exc()
    exit(1)
