def call_gateway(user_id: str):
    """Gateway call used by user_client.fetch_user."""
    return {"ok": True, "user": user_id}
