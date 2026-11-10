# Input source template

A starting point for an input source of your own. Copy this folder to
`~/.config/qitt/input-sources/<name>/` (or to `input-sources/<name>/` here if you mean to
contribute it), fill in each file, and follow [docs/input-sources.md](../../docs/input-sources.md).

| File | What to write |
| --- | --- |
| `qitt.md` | qitt's charter section for this source. Required. |
| `worker.md` | The workers' charter section. Delete it if workers need nothing specific. |
| `intake.md` | The prompt of the webhook task that delivers this source's events. |
| `deny.txt` | The tools that send or post in this source. Delete it if the agents have none. |

Replace this README with what someone needs to run the source: the app or token to create, the
config files it reads, and how its events reach the webhook task.
