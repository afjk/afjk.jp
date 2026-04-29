const STORAGE_KEY = 'scenesync.userId';

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
  }

  loadOrCreateUserId() {
    let userId = localStorage.getItem(STORAGE_KEY);
    if (!userId) {
      userId = generateUserId();
      localStorage.setItem(STORAGE_KEY, userId);
    }
    return userId;
  }

  getUserId() {
    return this.userId;
  }
}

export function createUserManager() {
  return new UserManager();
}
