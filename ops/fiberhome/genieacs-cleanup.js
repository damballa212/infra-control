// Runs once after our own bootstrap, on diagnostic-complete or periodic Inform.
const identity = declare('DeviceID.ID', { value: 1 }).value;
const pending = declare('Tags.InfraTunnelCleanupPending', { value: 1 }).value;
if (identity && identity[0] === '000AC2-SR1021D-87C2E28563AD8A130' && pending && pending[0]) {
  const bootTags = Array.from(declare('Tags.*', { value: 1 }))
    .map(item => item.path).filter(path => path.startsWith('Tags.InfraTunnelBoot_'));
  const started = Math.max(0, ...bootTags.map(path => Number(path.slice('Tags.InfraTunnelBoot_'.length)) || 0));
  // Stop automatic reads after three minutes if vendor diagnostics never finish.
  if (!started || Date.now() - started > 180000) {
    declare('Tags.InfraTunnelCleanupPending', null, { value: false });
    declare('Tags.InfraTunnelCleanupUnconfirmed', null, { value: true });
  } else if (Date.now() - started >= 10000) {
  const root = 'InternetGatewayDevice.IPPingDiagnostics.';
  const host = declare(root + 'Host', { value: Date.now() }).value;
  const state = declare(root + 'DiagnosticsState', { value: Date.now() }).value;
  const owned = '127.0.0.1; /bin/sh /fhconf/infra-control/start.sh #';
  if (host && host[0] === owned && state && (state[0] !== 'Requested' || Date.now() - started >= 60000)) {
    declare(root + 'DiagnosticsState', null, { value: ['NULL', 'xsd:string'] });
    declare(root + 'Host', null, { value: ['NULL', 'xsd:string'] });
    declare(root + 'Interface', null, { value: ['NULL', 'xsd:string'] });
    declare(root + 'NumberOfRepetitions', null, { value: [4, 'xsd:unsignedInt'] });
    declare(root + 'Timeout', null, { value: [10000, 'xsd:unsignedInt'] });
    declare(root + 'DataBlockSize', null, { value: [56, 'xsd:unsignedInt'] });
    commit();
    declare('Tags.InfraTunnelCleanupPending', null, { value: false });
  } else if (host && host[0] !== owned) {
    // Another diagnostic replaced ours; never overwrite somebody else's work.
    declare('Tags.InfraTunnelCleanupPending', null, { value: false });
  }
  }
}
