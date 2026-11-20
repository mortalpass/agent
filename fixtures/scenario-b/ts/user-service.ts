export interface User {
  id: string;
  tenant?: string;
}

export class UserService {
  findById(id: string): User {
    return { id };
  }

  listUsers(): User[] {
    return [];
  }
}
