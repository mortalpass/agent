import { UserService } from "./user-service";

test("findById returns the user", () => {
  const service = new UserService();
  expect(service.findById("u1").id).toBe("u1");
});
