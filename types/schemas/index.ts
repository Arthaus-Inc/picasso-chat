// Message
export type Message = {
  type?: string
  role: string
  content: string
}

// Query
export type Query = {
  userId: string
  messages: Message[]
}
