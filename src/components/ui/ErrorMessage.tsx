export default function ErrorMessage({ message }: { message: string | null | undefined }) {
  if (!message) return null
  return (
    <div className="error-message" role="alert">
      {message}
    </div>
  )
}
