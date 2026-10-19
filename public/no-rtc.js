// Loaded first. The app never uses WebRTC: calls run over a WebSocket to the local backend, which reaches the other side through the
// Anyone proxy. A stray RTCPeerConnection would send UDP (STUN/ICE) straight from this machine and reveal the real IP address, so the
// WebRTC API is removed from the page before any other script runs (the desktop app also forces "no non-proxied UDP" in the browser itself).
(function () {
  var names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport'];
  for (var i = 0; i < names.length; i++) {
    try { Object.defineProperty(window, names[i], { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
})();
