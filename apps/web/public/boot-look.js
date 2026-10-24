// Runs before first paint (a classic script, because the CSP forbids inline ones): applies the cached look (the last
// applied theme's attributes and generated token sheet, `score.look.cache`) or the saved 8.3 theme pack, and the
// colour mode, so the page never flashes the default look. src/themes/ does the same, from the server's copy, once
// React starts. `?look=safe` skips all of it. A <style> text node is fine under the CSP (style-src 'unsafe-inline').
;(function () {
  var root = document.documentElement
  var NAMES = {
    'data-pack': 1,
    'data-layout': 1,
    'data-density': 1,
    'data-radius': 1,
    'data-elevation': 1,
    'data-surface': 1,
    'data-border': 1,
    'data-nav': 1,
    'data-width': 1,
    'data-chat': 1,
    'data-rooms': 1,
    'data-backdrop': 1,
    'data-look': 1,
    'data-contrast-fallback': 1,
  }
  var safe = false
  try {
    safe = new URLSearchParams(window.location.search).get('look') === 'safe'
  } catch {
    // No URL parsing: not safe mode.
  }
  try {
    if (!safe) {
      var cache = JSON.parse(window.localStorage.getItem('score.look.cache') || 'null')
      var device = window.localStorage.getItem('score.look.device')
      var usable = cache && typeof cache === 'object' && cache.attributes
      // A device that picked its own theme since the cache was written must not paint the old one.
      if (usable && device && cache.id !== device) usable = false
      if (usable) {
        for (var name in cache.attributes) {
          var value = cache.attributes[name]
          if (NAMES[name] === 1 && typeof value === 'string' && /^[a-z0-9-]{0,16}$/.test(value))
            root.setAttribute(name, value)
        }
        if (
          typeof cache.css === 'string' &&
          cache.css.length < 100000 &&
          root.getAttribute('data-look') === 'custom'
        ) {
          var style = document.createElement('style')
          style.id = 'score-look-boot'
          style.textContent = cache.css
          document.head.appendChild(style)
        }
      } else {
        var look = JSON.parse(window.localStorage.getItem('score.look') || 'null')
        if (look && /^[a-z]{1,16}$/.test(look.pack)) {
          root.setAttribute('data-pack', look.pack)
          root.setAttribute('data-layout', look.layout === 'side' ? 'side' : 'top')
          root.setAttribute('data-density', look.density === 'compact' ? 'compact' : 'comfortable')
        }
      }
    }
    var mode = window.localStorage.getItem('score.theme')
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode)
  } catch {
    // Blocked storage: the default look.
  }
  if (!root.hasAttribute('data-pack')) {
    root.setAttribute('data-pack', 'score')
    root.setAttribute('data-layout', 'top')
    root.setAttribute('data-density', 'comfortable')
  }
})()
