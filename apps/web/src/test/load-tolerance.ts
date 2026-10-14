import { configure } from '@testing-library/react'

// Several suites run at once on a shared development machine: a find/waitFor that polls for 1 s (the default) gives up
// on a slow render, not on a broken one. A passing test never waits this long.
configure({ asyncUtilTimeout: 5000 })
