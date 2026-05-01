import fs from 'fs/promises'
import path from 'path'

export class SessionStore {
  constructor(options = {}) {
    this.file = options.file || process.env.SCENE_SYNC_SESSION_FILE || null
    this.session = {
      sessionId: null,
      roomId: null,
      expiresAt: null,
      linkedAt: null
    }
  }

  async load() {
    if (!this.file) {
      return
    }

    try {
      const data = await fs.readFile(this.file, 'utf8')
      const loaded = JSON.parse(data)
      this.session = {
        sessionId: loaded.sessionId || null,
        roomId: loaded.roomId || null,
        expiresAt: loaded.expiresAt || null,
        linkedAt: loaded.linkedAt || null
      }
    } catch (e) {
      // file doesn't exist yet or is invalid; start fresh
    }
  }

  async save(session) {
    this.session = session
    if (!this.file) {
      return
    }

    try {
      const dir = path.dirname(this.file)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.session), {
        mode: 0o600
      })
      await fs.chmod(this.file, 0o600)
    } catch (e) {
      console.error(`Failed to save session to ${this.file}:`, e.message)
    }
  }

  async clear() {
    this.session = {
      sessionId: null,
      roomId: null,
      expiresAt: null,
      linkedAt: null
    }

    if (!this.file) {
      return
    }

    try {
      await fs.unlink(this.file)
    } catch (e) {
      // file doesn't exist; that's ok
    }
  }

  get() {
    return { ...this.session }
  }

  set(session) {
    this.session = {
      sessionId: session.sessionId || null,
      roomId: session.roomId || null,
      expiresAt: session.expiresAt || null,
      linkedAt: session.linkedAt || null
    }
  }

  isLinked() {
    return !!(this.session.sessionId && this.session.roomId &&
      (!this.session.expiresAt || this.session.expiresAt > Date.now()))
  }
}
