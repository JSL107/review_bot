import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// `시작하기.command` 는 관리자 권한 없이 쓰도록 Node·gh·codex·claude 를 ~/.review_bot/tools 에 설치한다.
// 서버·CLI·점검이 그 도구를 찾을 수 있게 PATH 앞에 붙인다. 진입점에서 가장 먼저 import 한다.
const home = process.env.REVIEW_BOT_HOME ?? join(homedir(), '.review_bot');
const toolDirs = [join(home, 'tools', 'bin'), join(home, 'tools', 'node', 'bin')];
process.env.PATH = [...toolDirs, process.env.PATH ?? ''].filter((part) => part.length > 0).join(delimiter);
