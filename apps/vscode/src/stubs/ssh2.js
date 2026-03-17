// Stub for ssh2 — dockerode's docker-modem requires ssh2 at load time,
// but we only connect to Docker via local socket/named pipe, never SSH.
// This stub satisfies the require('ssh2').Client reference without
// pulling in the native ssh2/cpu-features binaries.
module.exports = { Client: function() {} };
