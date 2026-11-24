"""Bounded local render probe; metadata only to private scratch, never credentials."""
import json
import os
from pathlib import Path
import tempfile
import threading
from broker import Broker


def main():
    metadata = Path(os.environ['TMPDIR']) / 'credential-pilot-browser-metadata.json'
    with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='credential-render-') as private:
        broker = Broker(private)
        worker = threading.Thread(target=broker.serve_forever)
        worker.start()
        try:
            import http.client
            connection = http.client.HTTPConnection('127.0.0.1', broker.server_port, timeout=5)
            body = json.dumps({'target': 'process', 'ttl': 120})
            connection.request('POST', '/requests', body, {'Authorization':'Bearer '+broker.agent_token,
                               'Content-Type':'application/json','Idempotency-Key':'browser-render'})
            response = connection.getresponse()
            assert response.status == 200
            data = json.loads(response.read())
            connection.close()
            fd = os.open(metadata, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as stream:
                json.dump({'link':data['link']},stream)
            print('loopback_render_probe_ready', flush=True)
            threading.Event().wait(60)
            assert broker.requests[data['id']]['status'] == 'pending'
            print('GET_did_not_consume=true', flush=True)
        finally:
            broker.shutdown()
            broker.server_close()
            worker.join(5)
            metadata.unlink(missing_ok=True)
            print('loopback_render_probe_stopped', flush=True)


if __name__ == '__main__':
    main()
