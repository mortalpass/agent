import unittest

from py.user_client import fetch_user


class FetchUserTest(unittest.TestCase):
    def test_fetch_user_passthrough(self):
        self.assertEqual(fetch_user("u1")["user"], "u1")


if __name__ == "__main__":
    unittest.main()
