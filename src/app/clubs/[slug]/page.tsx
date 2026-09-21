import { permanentRedirect } from "next/navigation";

/**
 * A club owner looking for their own club types `/clubs/<their club>`, because that is where a page
 * about a club would be. It was a 404, and one of them spent seven of his ten minutes proving an
 * absence. A club's page is its board at `/v/<slug>`; this is the door people actually knock on.
 */
export default async function ClubBySlug({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  permanentRedirect(`/v/${slug.toLowerCase()}`);
}
