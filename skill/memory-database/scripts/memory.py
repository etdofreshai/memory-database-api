#!/usr/bin/env python3
"""Dependency-free, GET-only client for the direct Memory API."""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request


def configuration():
    values = {}
    path = Path(__file__).resolve().parent.parent / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
                continue
            key, value = line.removeprefix('export ').split('=', 1)
            if key.strip() in ('MEMORY_DATABASE_API_URL', 'MEMORY_DATABASE_API_TOKEN'):
                parsed = shlex.split(value, comments=True)
                values[key.strip()] = parsed[0] if parsed else ''
    values.update({key: os.environ[key] for key in ('MEMORY_DATABASE_API_URL', 'MEMORY_DATABASE_API_TOKEN') if key in os.environ})
    if not all(values.get(k) for k in ('MEMORY_DATABASE_API_URL', 'MEMORY_DATABASE_API_TOKEN')):
        raise ValueError('Configure MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN in the skill .env or environment')
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    search = commands.add_parser('search')
    search.add_argument('query')
    for name in ('source', 'sender', 'recipient', 'after', 'before'):
        search.add_argument('--' + name)
    search.add_argument('--limit', type=int, default=10)
    search.add_argument('--mode', choices=('terms', 'phrase'), default='terms')
    search.add_argument('--include-noise', action='store_true')
    for name in ('record', 'context'):
        sub = commands.add_parser(name)
        sub.add_argument('record_id')
        if name == 'context':
            sub.add_argument('--limit', type=int, default=5)
    commands.add_parser('sources')
    transactions = commands.add_parser('transactions')
    for name in ('after','before','merchant','category'):
        transactions.add_argument('--' + name)
    transactions.add_argument('--limit', type=int, default=50)
    transactions.add_argument('--page', type=int, default=1)
    attachments = commands.add_parser('attachments')
    attachments.add_argument('--query')
    attachments.add_argument('--mime-type')
    attachments.add_argument('--limit', type=int, default=20)
    attachments.add_argument('--page', type=int, default=1)
    args = vars(parser.parse_args())
    command = args.pop('command')
    if command == 'search':
        path = '/api/memory/search'
        args['q'] = args.pop('query')
        args['include_noise'] = str(args['include_noise']).lower()
    elif command in ('record', 'context'):
        path = '/api/memory/records/' + urllib.parse.quote(args.pop('record_id'), safe='')
        if command == 'context': path += '/context'
    elif command == 'sources':
        path = '/api/memory/sources'
    elif command == 'transactions':
        path = '/api/transactions'
        args['date_from'] = args.pop('after')
        args['date_to'] = args.pop('before')
    else:
        path = '/api/attachments'
        args['q'] = args.pop('query')
    config = configuration()
    url = config['MEMORY_DATABASE_API_URL'].rstrip('/') + path
    params = {k: v for k, v in args.items() if v is not None}
    if params: url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + config['MEMORY_DATABASE_API_TOKEN'],
        'User-Agent': 'Mozilla/5.0 MemoryReader/1.0', 'Accept': 'application/json'}, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            result = json.load(response)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        print(json.dumps({'error': 'Memory API request failed', 'http_status': error.code}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
