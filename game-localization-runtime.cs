// Build-time only, using Mono.Cecil 0.11.6.
// Pass the stock game DLL and output path for tab and interval text.
// Pass that output, a new output path and the SmartFormat time DLL to localize duration units.
using System;
using System.Linq;
using System.Text.RegularExpressions;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal static class LocalizeRuntime
{
    private static void Main(string[] args)
    {
        using var assembly = AssemblyDefinition.ReadAssembly(args[0]);
        var module = assembly.MainModule;
        if (args.Length == 3)
        {
            LocalizeDurations(module, args[2]);
            assembly.Write(args[1]);
            return;
        }
        var interval = module.GetType("GamesByMalcs.Melvor2.SmartFormatExtensions.IntervalTime.IntervalTimeFormatter")
            .Methods.Single(method => method.Name == "TryEvaluateFormat");
        interval.Body.Instructions.Single(instruction => instruction.OpCode == OpCodes.Ldstr &&
            Equals(instruction.Operand, "s")).Operand = "秒";

        var tab = module.GetType("GamesByMalcs.Melvor2.Entities.Bank.TabButton")
            .Methods.Single(method => method.Name == "UpdateTab");
        var display = tab.Body.Instructions.Single(instruction => instruction.Operand is MethodReference method &&
            method.DeclaringType.FullName == "Godot.Label" && method.Name == "set_Text");
        var replace = typeof(Regex).GetMethod(nameof(Regex.Replace), new[] { typeof(string), typeof(string), typeof(string) })!;
        var il = tab.Body.GetILProcessor();
        il.InsertBefore(display, il.Create(OpCodes.Ldstr, @"^Tab ([0-9]+)$"));
        il.InsertBefore(display, il.Create(OpCodes.Ldstr, "分页 $1"));
        il.InsertBefore(display, il.Create(OpCodes.Call, module.ImportReference(replace)));
        tab.Body.MaxStackSize += 2;
        assembly.Write(args[1]);
    }

    private static void LocalizeDurations(ModuleDefinition module, string library)
    {
        using var time = AssemblyDefinition.ReadAssembly(library);
        var units = time.MainModule.GetType("SmartFormat.Extensions.Time.Utilities.TimeTextInfo");
        var languages = time.MainModule.GetType("SmartFormat.Extensions.Time.Utilities.CommonLanguagesTimeTextInfo");
        var config = module.GetType("GamesByMalcs.Melvor2.AutoLoads.SmartFormatConfig");
        var method = new MethodDefinition("ConfigureChineseDurationUnits",
            MethodAttributes.Private | MethodAttributes.Static, module.TypeSystem.Void);
        config.Methods.Add(method);
        var unitInfo = new VariableDefinition(module.ImportReference(units));
        method.Body.Variables.Add(unitInfo);
        method.Body.InitLocals = true;
        var il = method.Body.GetILProcessor();
        var end = il.Create(OpCodes.Ret);
        il.Emit(OpCodes.Ldstr, "en");
        il.Emit(OpCodes.Call, module.ImportReference(languages.Methods.Single(member => member.Name == "GetTimeTextInfo")));
        il.Emit(OpCodes.Stloc, unitInfo);
        il.Emit(OpCodes.Ldloc, unitInfo);
        il.Emit(OpCodes.Brfalse, end);
        foreach (var (property, text) in new[] {
            ("w", "周"), ("week", "周"), ("d", "天"), ("day", "天"), ("h", "小时"), ("hour", "小时"),
            ("m", "分钟"), ("minute", "分钟"), ("s", "秒"), ("second", "秒"), ("ms", "毫秒"), ("millisecond", "毫秒")
        })
        {
            il.Emit(OpCodes.Ldloc, unitInfo);
            il.Emit(OpCodes.Ldc_I4_1);
            il.Emit(OpCodes.Newarr, module.TypeSystem.String);
            il.Emit(OpCodes.Dup);
            il.Emit(OpCodes.Ldc_I4_0);
            il.Emit(OpCodes.Ldstr, "{0}" + text);
            il.Emit(OpCodes.Stelem_Ref);
            il.Emit(OpCodes.Callvirt, module.ImportReference(units.Methods.Single(member => member.Name == "set_Ptxt_" + property)));
        }
        il.Emit(OpCodes.Ldloc, unitInfo);
        il.Emit(OpCodes.Ldstr, "少于{0}");
        il.Emit(OpCodes.Callvirt, module.ImportReference(units.Methods.Single(member => member.Name == "set_Ptxt_lessThan")));
        il.Append(end);
        var ctor = config.Methods.Single(member => member.IsConstructor && !member.IsStatic);
        var constructor = ctor.Body.GetILProcessor();
        foreach (var ret in ctor.Body.Instructions.Where(instruction => instruction.OpCode == OpCodes.Ret).ToArray())
            constructor.InsertBefore(ret, constructor.Create(OpCodes.Call, method));
    }
}
