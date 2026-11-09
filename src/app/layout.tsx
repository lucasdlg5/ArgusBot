import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Argus Vision BI — Market Arbitrage, Recipe Costing & Open Finance Intelligence',
  description:
    'Argus (moneta-argus) - O guardião de cem olhos do ecossistema Moneta, focado em inteligência de consumo, detector de reduflação, custo de receitas e simulador logístico OSRM.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="antialiased bg-[#090d16] text-slate-100 selection:bg-emerald-500 selection:text-slate-950">
        {children}
      </body>
    </html>
  );
}
