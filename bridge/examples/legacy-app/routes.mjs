// Routes moved from PHP to Node. Everything else still runs on PHP.
export default (bridge) => {
  // Same URL the PHP app answered; Node now answers it, reading the PHP session.
  bridge.get('/whoami', async (req, res) => {
    const session = await req.phpSession();
    res.json({ servedBy: 'node', user: session?.user ?? null });
  });
};
