/** "How to make a pack": the naming table and rules the owner approved in the preview (decisions 107–108). */
const rows: [files: string[], when: string, does: string, kind: string][] = [
  [
    ['idle'],
    'Resting (the default) · required',
    'Stands, breathes, blinks, a small sway',
    'loop 2–8 s',
  ],
  [['work'], 'The agent is working', 'Types at a desk or laptop', 'loop 2–8 s'],
  [['think'], 'Thinking or planning', 'Hand on chin, looks up, head tilt', 'loop 2–4 s'],
  [['needs'], 'Waiting for your approval or answer', 'Waves at you, a small hop', 'loop 1–3 s'],
  [['sleep'], 'Idle for a while', 'Naps (on a pillow, or dozing at the desk)', 'loop 3–6 s'],
  [
    ['walk'],
    'Optional: strolling while resting',
    'Walks in place, side view facing right (Score mirrors it)',
    'loop',
  ],
  [
    ['stretch', 'coffee', 'read'],
    'Optional: breaks while resting or working',
    'Arms up and a yawn; a sip of coffee; reading a book',
    'one-shot or loop',
  ],
  [
    ['greet', 'happy'],
    'Optional: you point at it; you click it',
    'A wave hello; a happy bounce',
    'one-shot ~1 s',
  ],
]

export function PetPackGuide() {
  return (
    <details className="team-pack-guide">
      <summary>How to make a pack</summary>
      <p>
        A pack is a ZIP (or a folder of files) of looping animations, one file per activity, named
        exactly as below. Upload it here: Upload a pet pack.
      </p>
      <div className="team-pack-table">
        <table>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Played when</th>
              <th scope="col">What the character does</th>
              <th scope="col">Kind</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([files, when, does, kind]) => (
              <tr key={files.join()}>
                <th scope="row">
                  {files.map((file, index) => (
                    <span key={file}>
                      {index > 0 && ', '}
                      <code>{file}</code>
                    </span>
                  ))}
                </th>
                <td>{when}</td>
                <td>{does}</td>
                <td>{kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>Format:</strong> animated WebP (best), APNG (<code>.png</code>) or GIF, with a
          transparent background. A still PNG works too.
        </li>
        <li>
          <strong>Same framing in every file:</strong> the same character height, centred, feet on
          the same line near the bottom. Widths may differ; Score lines files up by height and the
          floor.
        </li>
        <li>
          <strong>Seamless loops:</strong> the last frame flows into the first. One-shots start and
          end in the <code>idle</code> pose.
        </li>
        <li>
          <strong>Props belong in the animation</strong> (the desk in <code>work</code>, the pillow
          in <code>sleep</code>).
        </li>
        <li>
          <strong>Limits:</strong> up to 32 MB per file and 256 MB per pack; 64–2048 px per side.
          12–24 frames per second is plenty.
        </li>
        <li>
          <strong>Missing activities</strong> fall back to <code>idle</code> with Score’s overlays
          (thought dots, a “!” with a hop, sleeping z’s), so a pack with only <code>idle</code>{' '}
          already works.
        </li>
        <li>
          <strong>Colour and shape still identify the agent:</strong> a small badge with its mark
          sits on the avatar, and lists show the mark.
        </li>
      </ul>
      <p>
        Optional <code>pet.json</code> beside the files:
      </p>
      <pre>{`{
  "name": "Luna",
  "credits": "Drawn by …, licensed for personal use",
  "floor": 0.03
}`}</pre>
      <p className="team-muted">
        <code>floor</code> moves the character up by that share of its height if its feet sit too
        low in the files. Score never runs anything from a pack: only the images and this file are
        read.
      </p>
    </details>
  )
}
