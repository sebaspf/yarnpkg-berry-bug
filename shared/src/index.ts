export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Greeting {
  message: string;
  timestamp: Date;
}

export const DEFAULT_USER: User = {
  id: "0",
  name: "Default User",
  email: "default@example.com"
}

export function greet(user: User): string {
  return `Hello, ${user.name}!`;
}
