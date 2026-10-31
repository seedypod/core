"""Validate this repository's OKF authoring profile (not scientific validity)."""
from datetime import datetime, date
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
import yaml

ROOT = Path(__file__).resolve().parents[1] / 'knowledge'


def check(root=ROOT):
    errors = []
    concepts = 0
    def require(condition, path, message):
        if not condition:
            errors.append(f'{path.relative_to(root)}: {message}')
    def timestamp(value):
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00')).tzinfo is not None
        except ValueError:
            return False
    def local_link(path, link):
        url = urlsplit(link)
        if url.scheme or url.netloc or not url.path:
            return
        target = ((root / unquote(url.path).lstrip('/')) if url.path.startswith('/')
                  else path.parent / unquote(url.path)).resolve()
        require(target.is_relative_to(root.resolve()), path, f'link escapes bundle: {link}')
        require(target.exists(), path, f'missing link: {link}')
    for path in sorted(root.rglob('*.md')):
        text = path.read_text()
        front = re.match(r'\A---\n(.*?)\n---\n', text, re.S)
        body = text[front.end():] if front else text
        try:
            meta = yaml.safe_load(front.group(1)) if front else None
        except yaml.YAMLError as exc:
            errors.append(f'{path.relative_to(root)}: invalid YAML: {exc}')
            continue
        if path.name in ('index.md', 'log.md'):
            if path == root / 'index.md':
                require(meta == {'okf_version': '0.2'}, path, 'root must declare OKF 0.2')
            else:
                require(front is None, path, 'reserved file must not have frontmatter')
            if path.name == 'log.md':
                headings = re.findall(r'^## (.+)$', body, re.M)
                require(bool(headings), path, 'missing dated log entries')
                for heading in headings:
                    try:
                        date.fromisoformat(heading)
                    except ValueError:
                        require(False, path, f'invalid log date: {heading}')
                require(headings == sorted(headings, reverse=True), path, 'log must be newest first')
        else:
            concepts += 1
            if not isinstance(meta, dict):
                require(False, path, 'missing frontmatter mapping')
                continue
            for key in ('type', 'title', 'description'):
                require(isinstance(meta.get(key), str) and bool(meta[key].strip()), path, f'missing {key}')
            require(meta.get('status') in ('draft', 'stable', 'deprecated'), path, 'invalid status')
            actors = [meta.get('generated')]
            verified = meta.get('verified', [])
            actors += verified if isinstance(verified, list) else [verified]
            for actor in actors:
                require(isinstance(actor, dict) and bool(actor.get('by')) and timestamp(actor.get('at')), path, 'invalid actor/timestamp')
            sources = meta.get('sources', [])
            require(isinstance(sources, list) and bool(sources), path, 'sources required by local policy')
            for source in sources if isinstance(sources, list) else []:
                resource = source.get('resource') if isinstance(source, dict) else None
                require(isinstance(resource, str) and bool(resource.strip()), path, 'invalid source')
                if isinstance(resource, str) and resource.startswith(('/', './', '../')):
                    local_link(path, resource)
        for link in re.findall(r'\[[^\]]*\]\(([^)\s]+)\)', body):
            local_link(path, link)
    require((root / 'index.md').exists(), root / 'index.md', 'missing bundle index')
    return concepts, errors


if __name__ == '__main__':
    count, errors = check()
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        sys.exit(1)
    print(f'Validated {count} concepts: OKF metadata and local links. Scientific claims not verified.')
