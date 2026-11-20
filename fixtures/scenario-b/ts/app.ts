import { UserService } from "./user-service";

export function onboard(id: string): string {
  const service = new UserService();
  const user = service.findById(id);
  return `onboarded: ${user.id}`;
}
