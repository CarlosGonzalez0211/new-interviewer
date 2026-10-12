import Card from './ui/Card'

export default function SetupScreen({ missing }: { missing: string[] }) {
  return (
    <div className="center-screen">
      <Card className="narrow">
        <h1>Setup required</h1>
        <p>This app needs a Supabase project before it can run. These environment variables are missing:</p>
        <ul>
          {missing.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p className="muted">
          Copy <code>.env.example</code> to <code>.env.local</code>, fill in your project URL and anon key, then
          restart the dev server. On Vercel, add them under Project Settings, Environment Variables and redeploy. See{' '}
          <code>README.md</code> for details.
        </p>
      </Card>
    </div>
  )
}
