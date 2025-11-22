"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://uber-backend-btn5.onrender.com";

export default function AdminPage() {
  const router = useRouter();

  const [userId, setUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);

  const [phoneInput, setPhoneInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Protect this route: only admin can see
  useEffect(() => {
    if (typeof window === "undefined") return;

    const id = window.localStorage.getItem("userId");
    const adminFlag = window.localStorage.getItem("isAdmin");

    if (!id) {
      router.replace("/login");
      return;
    }

    if (adminFlag !== "1") {
      // Not admin → send them to normal dashboard
      router.replace("/dashboard");
      return;
    }

    setUserId(id);
    setIsAdmin(true);
  }, [router]);

  async function handlePromote(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!userId) {
      setErrorMsg("Missing admin session.");
      return;
    }
    if (!phoneInput.trim()) {
      setErrorMsg("Enter a phone number to promote.");
      return;
    }

    const userIdHeader = userId; // non-null string

    try {
      setLoading(true);

      const res = await fetch(`${API_BASE_URL}/admin/promote-driver`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userIdHeader,
        },
        body: JSON.stringify({
          phone: phoneInput.trim(),
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      let data: any = {};
      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        data = { error: text };
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to promote user.");
      }

      const promoted = data.user;

      setSuccessMsg(
        `User ${promoted.phone} is now a driver (id: ${promoted.id}).`
      );
      setErrorMsg(null);
      setPhoneInput("");
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Error promoting user.");
    } finally {
      setLoading(false);
    }
  }

  // While checking admin
  if (!isAdmin && !userId) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-sm text-zinc-400">Checking admin access…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white pb-10">
      <div className="max-w-md mx-auto px-4 pt-6 pb-4">
        <header className="mb-4">
          <p className="text-[11px] text-zinc-500 mb-1">Admin panel</p>
          <h1 className="text-lg font-semibold">Promote driver</h1>
          <p className="text-[11px] text-zinc-500 mt-1">
            Only you (admin) can see this page. Type a rider&apos;s phone number to
            turn them into a driver.
          </p>
        </header>

        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 px-3 py-3">
          <form onSubmit={handlePromote} className="space-y-2">
            <div>
              <label className="block text-[11px] text-zinc-500 mb-1">
                Rider phone to promote
              </label>
              <input
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="e.g. 204XXXXXXX or +1204XXXXXXX"
                className="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-zinc-500 mt-1">
                You can paste 10-digit or +1 format. Backend will normalize it.
              </p>
            </div>

            {errorMsg && (
              <p className="text-[11px] text-red-300">{errorMsg}</p>
            )}
            {successMsg && (
              <p className="text-[11px] text-emerald-300">{successMsg}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-emerald-500 text-black text-xs font-semibold py-2 disabled:opacity-60"
            >
              {loading ? "Promoting..." : "Promote to driver"}
            </button>
          </form>
        </section>

        <button
          onClick={() => router.push("/dashboard")}
          className="mt-4 text-[11px] text-zinc-400 underline"
        >
          ← Back to dashboard
        </button>
      </div>
    </main>
  );
}
