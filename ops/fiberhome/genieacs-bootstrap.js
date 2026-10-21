// GenieACS provision, applied ONLY to this CPE on 1 BOOT / 0 BOOTSTRAP.
// Date.now() is fixed for the CWMP session in GenieACS 1.2.16.
const identity = declare('DeviceID.ID', { value: 1 }).value;
if (identity && identity[0] === '000AC2-SR1021D-87C2E28563AD8A130') {
  const prefix = 'Tags.InfraTunnelBoot_';
  const tag = prefix + Date.now();
  const seen = declare(tag, { value: 1 }).value;
  if (!seen || !seen[0]) {
    const ownedTags = Array.from(declare('Tags.*', { value: 1 }))
      .map(item => item.path).filter(path => path.startsWith(prefix) && path !== tag);
    const root = 'InternetGatewayDevice.IPPingDiagnostics.';
    const command = '127.0.0.1; /bin/sh /fhconf/infra-control/start.sh #';
    declare(root + 'Host', { value: Date.now() }, { value: [command, 'xsd:string'] });
    declare(root + 'Interface', { value: Date.now() }, { value: ['InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.IPInterface.1.', 'xsd:string'] });
    declare(root + 'NumberOfRepetitions', { value: Date.now() }, { value: [1, 'xsd:unsignedInt'] });
    declare(root + 'Timeout', { value: Date.now() }, { value: [1000, 'xsd:unsignedInt'] });
    declare(root + 'DataBlockSize', { value: Date.now() }, { value: [56, 'xsd:unsignedInt'] });
    declare(root + 'DiagnosticsState', { value: Date.now() }, { value: ['Requested', 'xsd:string'] });
    // Acknowledge the device write before recording the server-side guard.
    commit();
    declare(tag, null, { value: true });
    declare('Tags.InfraTunnelCleanupPending', null, { value: true });
    declare('Tags.InfraTunnelCleanupUnconfirmed', null, { value: false });
    for (const old of ownedTags) declare(old, null, { value: false });
  }
}
