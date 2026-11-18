"""Exercise the real dotenv parser on files a same-UID task could open."""

import pytest

from ai.web.env_policy import validate_hosted_env_file


@pytest.mark.parametrize('flag', ['--saas', '--hosted'])
@pytest.mark.parametrize(
    'line', ['RR_SIGNING_KEY=secret-do-not-print', 'export AWS_SECRET_ACCESS_KEY="secret-do-not-print"', 'EMPTY=']
)
def test_hosted_engine_refuses_populated_install_env(tmp_path, flag, line):
    path = tmp_path / '.env'
    path.write_text(line, encoding='utf-8')
    with pytest.raises(RuntimeError, match='remove the install .env') as error:
        validate_hosted_env_file(str(path), [flag])
    assert 'secret-do-not-print' not in str(error.value)
    assert path.read_text(encoding='utf-8') == line


def test_local_oss_keeps_dotenv_support(tmp_path):
    path = tmp_path / '.env'
    path.write_text('RR_SIGNING_KEY=local', encoding='utf-8')
    validate_hosted_env_file(str(path), [])


@pytest.mark.parametrize('content', [None, '', '# Configuration is injected by the pod\n'])
def test_hosted_accepts_absent_empty_or_comment_only_env(tmp_path, content):
    path = tmp_path / '.env'
    if content is not None:
        path.write_text(content, encoding='utf-8')
    validate_hosted_env_file(str(path), ['--saas'])
