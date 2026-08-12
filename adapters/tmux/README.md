# Optional tmux adapter

The package never modifies tmux configuration. To opt in, source the adapter:

```tmux
source-file /absolute/path/to/chrysaki-pi/adapters/tmux/chrysaki-pi.conf
```

With the Chrysaki prefix set to `Ctrl+Space`:

- `Ctrl+Space`, `Space` remains the existing tmux palette.
- `Ctrl+Space`, `p` forwards `Ctrl+Shift+P` to Pi and opens the Chrysaki command deck.

## Rollback

Remove the `source-file` line (or the copied `bind-key p ...` line), then run:

```bash
tmux source-file ~/.tmux.conf
```

No Pi or tmux settings are changed automatically.
