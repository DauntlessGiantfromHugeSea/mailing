import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { CampaignForm } from "@/components/CampaignForm";
import { prisma } from "@/lib/db";
import { canEdit, roleLabel } from "@/lib/rbac";
import { getDefaults } from "@/lib/settings";
import { loadSenderStats } from "@/lib/senders";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!canEdit(s)) {
    redirect(
      "/campaigns?error=" +
        encodeURIComponent(
          `Kampagnen anlegen ist Bearbeitern vorbehalten. Deine Rolle ist ${roleLabel(s.role)}.`
        )
    );
  }

  const [lists, senders, defaults, totalActiveContacts] = await Promise.all([
    prisma.contactList.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { memberships: true } } },
    }),
    prisma.sender.findMany({ orderBy: { createdAt: "asc" } }),
    getDefaults(),
    prisma.contact.count({ where: { status: "ACTIVE" } }),
  ]);

  const stats = await loadSenderStats(senders);

  return (
    <Shell session={s} active="campaigns">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Neue Kampagne</h1>
          <p className="text-xs text-slate-500 mt-1">
            Der Versand startet nicht sofort — die Mails werden randomisiert eingeplant.
          </p>
        </div>
        <Link href="/campaigns" className="btn-secondary">
          Abbrechen
        </Link>
      </div>

      <Toasts error={searchParams.error} />

      <CampaignForm
        action="/api/campaigns"
        submitLabel="Planen &amp; starten"
        defaults={defaults}
        totalActiveContacts={totalActiveContacts}
        lists={lists.map((l) => ({ id: l.id, name: l.name, count: l._count.memberships }))}
        senders={stats.map((x) => ({
          id: x.sender.id,
          label: x.sender.label,
          email: x.sender.email,
          remaining: x.remaining,
          limit: x.limit,
          active: x.sender.active,
        }))}
      />
    </Shell>
  );
}
