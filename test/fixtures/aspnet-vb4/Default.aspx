<%@ Page Language="VB" %>
<!DOCTYPE html>
<script runat="server">
    Protected Sub IncrementCounter(sender As Object, e As EventArgs)
        Dim current As Integer = Integer.Parse(CounterValue.Text)
        CounterValue.Text = (current + 1).ToString()
        StatusLabel.Text = "更新済み"
    End Sub

    Protected Function IsIntentionalDiff() As Boolean
        Return String.Equals(Request.QueryString("variant"), "different", StringComparison.OrdinalIgnoreCase)
    End Function
</script>
<html lang="ja">
<head runat="server">
    <meta charset="utf-8" />
    <title>VB.NET 4.x VRT fixture</title>
    <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #f5f7fb; color: #172033; font-family: "Yu Gothic UI", sans-serif; }
        .main { width: 760px; margin: 48px auto; }
        .card { background: white; border: 1px solid #ccd4e0; border-radius: 8px; padding: 28px; }
        h1 { margin: 0 0 20px; font-size: 28px; }
        .row { display: table; width: 100%; margin: 14px 0; }
        .label, .value { display: table-cell; vertical-align: middle; }
        .label { width: 180px; font-weight: 600; }
        input[type=text] { width: 320px; height: 36px; border: 1px solid #8793a5; padding: 6px 10px; }
        .button { margin-top: 18px; width: 160px; height: 40px; border: 0; border-radius: 4px; color: white; background: <%= If(IsIntentionalDiff(), "#c62828", "#1769aa") %>; }
        .status { display: inline-block; margin-left: 18px; font-weight: 600; }
    </style>
</head>
<body>
    <form id="MigrationForm" runat="server">
        <div class="main">
            <section class="card">
                <h1>IE 移行 VRT 検証</h1>
                <div class="row"><span class="label">顧客コード</span><span class="value"><asp:TextBox ID="CustomerCode" runat="server" Text="RAYVEN-001" /></span></div>
                <div class="row"><span class="label">カウンター</span><span class="value"><asp:Label ID="CounterValue" runat="server" Text="0" /></span></div>
                <asp:Button ID="IncrementButton" runat="server" CssClass="button" Text="更新する" OnClick="IncrementCounter" />
                <asp:Label ID="StatusLabel" runat="server" CssClass="status" Text="未更新" />
            </section>
        </div>
    </form>
</body>
</html>
