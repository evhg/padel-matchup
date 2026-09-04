import { redirect } from "next/navigation";

/** The landing page is the create form; /new stays for old links. */
export default function NewEventPage() {
  redirect("/");
}
