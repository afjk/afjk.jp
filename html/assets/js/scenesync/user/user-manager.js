const STORAGE_KEY = 'scenesync.userId';
const NICKNAME_STORAGE_KEY = 'scenesync.nickname';

function generateUserId() {
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return `usr-${uuid}`;
}

export class UserManager {
  constructor() {
    this.userId = this.loadOrCreateUserId();
    this.nickname = this.loadNickname() || 'Anonymous';
  }

  loadOrCreateUserId() {
    let userId = localStorage.getItem(STORAGE_KEY);
    if (!userId) {
      userId = generateUserId();
      localStorage.setItem(STORAGE_KEY, userId);
    }
    return userId;
  }

  loadNickname() {
    return localStorage.getItem(NICKNAME_STORAGE_KEY);
  }

  setNickname(nickname) {
    this.nickname = nickname;
    localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  }

  getUserId() {
    return this.userId;
  }

  getNickname() {
    return this.nickname;
  }
}

export function createUserManager() {
  return new UserManager();
}
