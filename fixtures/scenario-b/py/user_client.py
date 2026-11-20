from py.gw import call_gateway


def fetch_user(user_id: str):
    return call_gateway(user_id)
