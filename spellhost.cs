// spellhost.cs -- a tiny console helper that asks the WINDOWS spellchecker
// (ISpellChecker, the same engine that draws Chromium's red underline on
// Windows) about single words. spell.js compiles it once with the .NET
// Framework compiler PowerShell already carries (Add-Type -OutputAssembly),
// keeps one copy running, and talks to it one line at a time:
//
//   stdin : <id>\t<word>\n
//   stdout: <id>\t<0|1 misspelled>\t<action>\t<replacement>\t<sugg1|sugg2|...>\n
//
// <action> is Windows' own verdict on the word: "none", "replace" (Windows is
// sure enough to auto-replace it, and <replacement> is what with), "suggest"
// or "delete". Only a line that starts with "ready" is printed before the
// first request, or "error\t<reason>" and an exit if the checker is missing.
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace QuartzSpell
{
    [ComImport, Guid("7AB36653-1796-484B-BDFA-E74F1DB7C1DC")]
    class SpellCheckerFactoryClass { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("8E018A9D-2415-4677-BF08-794EA61F94BB")]
    interface ISpellCheckerFactory
    {
        IEnumString SupportedLanguages { get; }
        int IsSupported([MarshalAs(UnmanagedType.LPWStr)] string languageTag);
        ISpellChecker CreateSpellChecker([MarshalAs(UnmanagedType.LPWStr)] string languageTag);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("B6FD0B71-E2BC-4653-8D05-F197E412770B")]
    interface ISpellChecker
    {
        string LanguageTag { [return: MarshalAs(UnmanagedType.LPWStr)] get; }
        IEnumSpellingError Check([MarshalAs(UnmanagedType.LPWStr)] string text);
        IEnumString Suggest([MarshalAs(UnmanagedType.LPWStr)] string word);
        // The rest of the vtable is never called; it does not need declaring.
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("803E3BD4-2828-4410-8290-418D1D73C762")]
    interface IEnumSpellingError
    {
        [PreserveSig] int Next(out ISpellingError value);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("B7C82D61-FBE8-4B47-9B27-6C0D2E0DE0A3")]
    interface ISpellingError
    {
        uint StartIndex { get; }
        uint Length { get; }
        int CorrectiveAction { get; }
        string Replacement { [return: MarshalAs(UnmanagedType.LPWStr)] get; }
    }

    static class Program
    {
        static string Clean(string s) { return (s ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " "); }

        [STAThread]
        static int Main(string[] args)
        {
            string lang = args.Length > 0 ? args[0] : "en-US";
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false);
            ISpellChecker checker;
            try
            {
                var factory = (ISpellCheckerFactory)new SpellCheckerFactoryClass();
                if (factory.IsSupported(lang) == 0) { Console.WriteLine("error\tWindows has no " + lang + " spellchecker installed."); return 2; }
                checker = factory.CreateSpellChecker(lang);
            }
            catch (Exception e) { Console.WriteLine("error\t" + Clean(e.Message)); return 1; }
            Console.WriteLine("ready\t" + lang);
            Console.Out.Flush();

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string id = line.Substring(0, tab);
                string word = line.Substring(tab + 1);
                var sb = new StringBuilder();
                try
                {
                    bool bad = false; string action = "none"; string repl = "";
                    var errs = checker.Check(word);
                    ISpellingError err;
                    if (errs.Next(out err) == 0 && err != null)
                    {
                        bad = true;
                        switch (err.CorrectiveAction) { case 1: action = "suggest"; break; case 2: action = "replace"; break; case 3: action = "delete"; break; }
                        if (err.CorrectiveAction == 2) repl = err.Replacement;
                    }
                    var list = new StringBuilder();
                    if (bad)
                    {
                        IEnumString sugg = checker.Suggest(word);
                        var one = new string[1];
                        int n = 0;
                        while (n < 8 && sugg.Next(1, one, IntPtr.Zero) == 0)
                        {
                            if (list.Length > 0) list.Append('|');
                            list.Append(Clean(one[0]).Replace("|", " "));
                            n++;
                        }
                    }
                    sb.Append(id).Append('\t').Append(bad ? "1" : "0").Append('\t').Append(action).Append('\t').Append(Clean(repl)).Append('\t').Append(list.ToString());
                }
                catch (Exception e) { sb.Clear(); sb.Append(id).Append("\terr\t").Append(Clean(e.Message)); }
                Console.WriteLine(sb.ToString());
                Console.Out.Flush();
            }
            return 0;
        }
    }
}
