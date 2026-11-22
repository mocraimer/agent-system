/** The two descriptor-owned operations used from fs-native-extensions 1.5.1. */
declare module 'fs-native-extensions' {
  export function tryLock(fd: number): boolean;
  export function unlock(fd: number): void;
}
