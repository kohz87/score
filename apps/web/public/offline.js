document.getElementById('retry').addEventListener('click', () => location.reload())
// Reload by itself when the connection comes back.
window.addEventListener('online', () => location.reload())
