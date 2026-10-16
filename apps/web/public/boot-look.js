// Runs before first paint (a classic script, because the CSP forbids inline ones): applies the saved theme pack and
// colour mode so the page never flashes the default look. src/data/pack.ts and theme.ts do the same once React starts.
;(function () {
  var root = document.documentElement
  try {
    var look = JSON.parse(window.localStorage.getItem('score.look') || 'null')
    if (look && /^[a-z]{1,16}$/.test(look.pack)) {
      root.setAttribute('data-pack', look.pack)
      root.setAttribute('data-layout', look.layout === 'side' ? 'side' : 'top')
      root.setAttribute('data-density', look.density === 'compact' ? 'compact' : 'comfortable')
    }
    var mode = window.localStorage.getItem('score.theme')
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode)
  } catch (error) {
    // Blocked storage: the default look.
  }
  if (!root.hasAttribute('data-pack')) {
    root.setAttribute('data-pack', 'score')
    root.setAttribute('data-layout', 'top')
    root.setAttribute('data-density', 'comfortable')
  }
})()
