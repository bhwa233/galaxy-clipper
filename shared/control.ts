import os from 'node:os'
import { z } from 'zod'
import path from 'node:path'

// The local channel the command line talks to the running client through: a Unix socket, or a named
// pipe on Windows, reachable only from this machine and, by its permissions, only by the user the
// client runs as. No network port is opened. A development build listens on a name of its own so it
// never answers for an installed client, and CLIPPER_SOCKET overrides the address outright - which is
// how a test instance is kept apart from the one the user has open.
export function controlAddress(development: boolean): string {
  if (process.env.CLIPPER_SOCKET) return process.env.CLIPPER_SOCKET
  const user = os.userInfo().username.replace(/[^\w.-]/g, '_')
  const name = `galaxy-clipper${development ? '-dev' : ''}-${user}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`
  // XDG_RUNTIME_DIR is private to the user already; the temporary directory is the fallback, where
  // the socket's own mode is what keeps other users out.
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `${name}.sock`)
}

// One JSON object per line each way: a request names a command and its input, and the reply carries
// the same id. The commands are the client's own, checked by the same schemas as the window's.
export type ControlRequest = { id: number; command: string; input: unknown }
export type ControlReply = { id: number; ok: boolean; [key: string]: unknown }
// A line longer than this is not a command the client understands, and is not read to its end.
export const MAX_LINE = 1024 * 1024

// Commands only the command line can send. They take explicit file paths, which the window never
// does: it chooses files in native dialogs. Main still checks every path before using it.
const id = z.string().uuid(), file = z.string().min(1).max(4096)
export const cliCommands = {
  'cli:media-import': z.object({ file }),
  'cli:captions-import': z.object({ id, file }),
  'cli:export': z.object({ id, format: z.enum(['txt', 'md', 'srt', 'vtt', 'soft', 'burn', 'video']), captions: z.enum(['current', 'bilingual']).default('current'), style: z.string().regex(/^[a-z0-9-]{3,64}$/i).optional(), output: file }),
  'cli:clip-export': z.object({ documentId: id, draftId: id, output: file }),
  'cli:clip-captions': z.object({ documentId: id, draftId: id, format: z.enum(['srt', 'vtt']), output: file }),
  'cli:cover-export': z.object({ documentId: id, coverId: id, output: file }),
} as const
